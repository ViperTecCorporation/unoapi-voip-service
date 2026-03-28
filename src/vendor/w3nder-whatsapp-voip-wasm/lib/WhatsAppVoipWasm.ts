import * as vm from "vm";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import {
  VoipConfig,
  VoipCallbacks,
  StartCallOptions,
  CallInfo,
  SignalingMessage,
  AudioConfig,
  VideoConfig,
  VideoFrame,
} from "./types";

class NodeWorkerMessagePort {
  private listeners: Map<string, Set<Function>> = new Map();
  private worker: Worker;
  public fullyConnected: Promise<NodeWorkerMessagePort>;
  public workerID: number = 0;
  public pthread_ptr: number = 0;
  public name: string;

  constructor(worker: Worker, name: string) {
    this.worker = worker;
    this.name = name;

    this.fullyConnected = new Promise((resolve) => {
      const loadedHandler = (msg: any) => {
        if (msg && msg.cmd === "loaded") {
          this.workerID = msg.workerID || 0;
          resolve(this);
        }
      };
      this.addMessageListener("cmd", loadedHandler);
    });

    worker.on("message", (data: any) => this.handleMessage(data));
    worker.on("error", (err) => {
      // Logs de erro críticos sempre são mostrados, mas podemos adicionar flag se necessário
      console.error("[WorkerMessagePort] Error:", err);
    });
  }

  private handleMessage(data: any): void {
    if (!data || typeof data !== "object") return;

    if (
      data.type === "callback" ||
      data.type === "waWasmWorkerCompatibleCallback"
    ) {
      let callbackName: string;
      let callbackArgs: any;

      if (data.__name) {
        callbackName = data.__name;
        callbackArgs = {};
        for (const key in data) {
          if (
            key !== "type" &&
            key !== "__name" &&
            key !== "prototype" &&
            key !== "args" &&
            !key.startsWith("__")
          ) {
            if (data.hasOwnProperty && data.hasOwnProperty(key)) {
              callbackArgs[key] = data[key];
            } else if (!data.hasOwnProperty) {
              callbackArgs[key] = data[key];
            }
          }
        }
      } else if (data.name) {
        callbackName = data.name;
        callbackArgs = data.args || {};
      } else if (data.payload?.name) {
        callbackName = data.payload.name;
        callbackArgs = data.payload.args || {};
      } else {
        return;
      }

      if (callbackName === "onSignalingXmpp") {
        if (!callbackArgs || Object.keys(callbackArgs).length === 0) {
          callbackArgs = {
            peerJid: data.peerJid,
            callId: data.callId,
            xmlPayload: data.xmlPayload,
          };
        }
      }

      let listenerData: any = callbackArgs;
      if (
        !callbackArgs ||
        Object.keys(callbackArgs).length === 0 ||
        (Object.keys(callbackArgs).length === 1 && callbackArgs.prototype)
      ) {
        listenerData = {};
        for (const key in data) {
          if (
            key !== "type" &&
            key !== "__name" &&
            key !== "prototype" &&
            key !== "args" &&
            !key.startsWith("__")
          ) {
            listenerData[key] = data[key];
          }
        }
      } else {
        if (callbackName === "sendDataToRelay") {
          if (data.data !== undefined) listenerData.data = data.data;
          if (data.len !== undefined) listenerData.len = data.len;
          if (data.ip !== undefined) listenerData.ip = data.ip;
          if (data.port !== undefined) listenerData.port = data.port;
        } else if (callbackName === "onCallEvent") {
          if (data.eventType !== undefined)
            listenerData.eventType = data.eventType;
          if (data.userData !== undefined)
            listenerData.userData = data.userData;
          if (data.eventDataJson !== undefined)
            listenerData.eventDataJson = data.eventDataJson;
        }
      }

      WhatsAppVoipWasm.notifyGlobalCallbackListeners(
        callbackName,
        listenerData
      );
      return;
    }

    const type = data.type || data.cmd;
    if (type) {
      const listeners = this.listeners.get(type);
      if (listeners) {
        for (const handler of listeners) {
          try {
            handler(data);
          } catch (e) {}
        }
      }
    }

    if (data.cmd && data.type !== "cmd") {
      const cmdListeners = this.listeners.get("cmd");
      if (cmdListeners) {
        for (const handler of cmdListeners) {
          try {
            handler(data);
          } catch (e) {}
        }
      }
    }
  }

  postMessage(msg: any, transferList?: any[]): void {
    if (msg && typeof msg === "object" && msg.cmd && !msg.type) {
      msg = { ...msg, type: "cmd" };
    }
    this.worker.postMessage(msg, transferList as any);
  }

  addMessageListener(type: string, handler: Function): Function {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
    return handler;
  }

  removeMessageListener(type: string, handler: Function): boolean {
    const listeners = this.listeners.get(type);
    return listeners ? listeners.delete(handler) : false;
  }

  removeAllMessageListeners(type: string): void {
    this.listeners.delete(type);
  }

  terminate(): void {
    this.worker.terminate();
  }
  close(): void {}
  isWrappingVirtualMessagePort(): boolean {
    return false;
  }
  getWorker(): Worker {
    return this.worker;
  }
}

// Tipo interno com resourcesPath e wasmPath obrigatórios (preenchidos no constructor)
interface InternalVoipConfig extends VoipConfig {
  resourcesPath: string;
  wasmPath: string;
}

export class WhatsAppVoipWasm {
  private config: InternalVoipConfig;
  private instance: any = null;
  private initialized = false;
  private moduleRegistry: Map<
    string,
    { deps: string[]; factory: Function; exports?: any }
  > = new Map();
  private vmContext: vm.Context | null = null;

  private unusedWorkers: NodeWorkerMessagePort[] = [];
  private runningWorkers: NodeWorkerMessagePort[] = [];
  private pthreads: Record<number, NodeWorkerMessagePort> = {};
  private nextWorkerID: number = 1;

  private static globalCallbackListeners: Map<string, Set<Function>> =
    new Map();
  private static globalCallbacksRegistered: boolean = false;

  public static registerGlobalCallbackListener(
    callbackName: string,
    handler: Function
  ): void {
    const key = `callback:${callbackName}`;
    if (!WhatsAppVoipWasm.globalCallbackListeners.has(key)) {
      WhatsAppVoipWasm.globalCallbackListeners.set(key, new Set());
    }
    WhatsAppVoipWasm.globalCallbackListeners.get(key)!.add(handler);
  }

  public static notifyGlobalCallbackListeners(
    callbackName: string,
    data: any
  ): void {
    const key = `callback:${callbackName}`;
    const listeners = WhatsAppVoipWasm.globalCallbackListeners.get(key);
    if (listeners && listeners.size > 0) {
      for (const handler of listeners) {
        try {
          handler(data);
        } catch (e) {}
      }
    }
  }

  private wasmModule: WebAssembly.Module | null = null;
  private wasmMemory: WebAssembly.Memory | null = null;
  private pthreadPoolSize: number = 20;

  private runDependencies: Set<string> = new Set();
  private removeRunDependencyCallback: ((dep: string) => void) | null = null;
  private workersLoadedCount: number = 0;

  private audioPlaybackLoopInterval: NodeJS.Timeout | null = null;
  private audioPlaybackBuffer: number | null = null;
  private isPlaybackActive: boolean = false;

  private voipStackInitialized = false;
  private voipStackInitPromise: Promise<void> | null = null;
  private voipReadyResolver: (() => void) | null = null;

  private workerModulesCode: string = "";
  private loaderCode: string = "";

  constructor(config: VoipConfig = {}) {
    // resourcesPath é opcional - usa __dirname por padrão (pasta onde está este arquivo)
    const basePath = config.resourcesPath
      ? (path.isAbsolute(config.resourcesPath)
          ? config.resourcesPath
          : path.resolve(process.cwd(), config.resourcesPath))
      : __dirname;
    
    // wasmPath é opcional - usa wasm-resources/whatsapp.wasm por padrão
    let wasmPath: string;
    if (config.wasmPath) {
      wasmPath = path.isAbsolute(config.wasmPath)
        ? config.wasmPath
        : path.resolve(process.cwd(), config.wasmPath);
    } else {
      wasmPath = path.join(basePath, "wasm-resources", "whatsapp.wasm");
    }

    this.config = {
      ...config,
      wasmPath,
      resourcesPath: basePath,
      enableLogs: config.enableLogs !== undefined ? config.enableLogs : true,
      options: {
        heartbeatInterval: 30,
        lobbyTimeout: 1,
        maxParticipantsScreenShare: 32,
        maxGroupSizeLongRingtone: 32,
        enablePassthroughVideoDecoder: false,
        ...config.options,
      },
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized)
      throw new Error("WhatsAppVoipWasm já foi inicializado");

    this.log("log", "Inicializando WhatsApp VoIP WASM...");

    const voipStorageDir = "/tmp/voip";
    try {
      if (!fs.existsSync(voipStorageDir))
        fs.mkdirSync(voipStorageDir, { recursive: true });
    } catch (e) {}

    const loaderFile = path.join(
      this.config.resourcesPath,
      "wasm-resources/loader.js"
    );
    const workerFile = path.join(
      this.config.resourcesPath,
      "wasm-resources/worker-modules.js"
    );

    if (!fs.existsSync(this.config.wasmPath))
      throw new Error(`Arquivo WASM não encontrado: ${this.config.wasmPath}`);
    if (!fs.existsSync(loaderFile))
      throw new Error(`Arquivo loader não encontrado: ${loaderFile}`);
    if (!fs.existsSync(workerFile))
      throw new Error(`Arquivo worker não encontrado: ${workerFile}`);

    const wasmBuffer = fs.readFileSync(this.config.wasmPath);
    this.loaderCode = fs.readFileSync(loaderFile, "utf8");
    this.workerModulesCode = fs.readFileSync(workerFile, "utf8");

    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 32768,
      shared: true,
    });
    this.wasmMemory = memory;
    this.wasmModule = await WebAssembly.compile(wasmBuffer);

    this.vmContext = this.createVMContext(memory);

    let loaderCode = this.loaderCode;
    const originalPattern =
      'typeof l=="object"&&typeof i=="object"?i.exports=d:typeof define=="function"';
    const patchedPattern =
      '(i.exports=d,!1)?i.exports=d:typeof define=="function"';
    if (loaderCode.includes(originalPattern)) {
      loaderCode = loaderCode.replace(originalPattern, patchedPattern);
    }

    vm.runInContext(loaderCode, this.vmContext);
    const wasmLoader = this.requireModule("WAWebVoipWebWasmLoader");

    if (typeof wasmLoader !== "function")
      throw new Error("WAWebVoipWebWasmLoader não é uma função");

    if (!WhatsAppVoipWasm.globalCallbacksRegistered)
      this.registerGlobalCallbacks();

    await this.initPThreadPool();
    const workersLoadingPromise = this.loadWasmModuleToAllWorkers();

    const readyPromise = wasmLoader({
      wasmBinary: wasmBuffer,
      wasmMemory: memory,
      locateFile: () => this.config.wasmPath,
      onRuntimeInitialized: () => {},
    });

    const [instance] = await Promise.all([readyPromise, workersLoadingPromise]);
    this.instance = instance;
    this.initialized = true;
  }

  getAvailableFunctions(): string[] {
    if (!this.instance) return [];
    return Object.keys(this.instance).filter(
      (k) => typeof this.instance[k] === "function"
    );
  }

  getAvailableExports(): {
    functions: string[];
    classes: string[];
    other: string[];
  } {
    if (!this.instance) return { functions: [], classes: [], other: [] };
    const functions: string[] = [],
      classes: string[] = [],
      other: string[] = [];
    for (const key of Object.keys(this.instance)) {
      const val = this.instance[key];
      if (typeof val === "function") {
        if (
          val.prototype &&
          val.prototype.constructor === val &&
          key[0] === key[0].toUpperCase()
        )
          classes.push(key);
        else functions.push(key);
      } else other.push(key);
    }
    return { functions, classes, other };
  }

  checkListClasses(): { StringList: boolean; Uint8List: boolean } {
    return {
      StringList: !!this.instance?.StringList,
      Uint8List: !!this.instance?.Uint8List,
    };
  }

  encodeToBase64(encodedBytes: Uint8Array | Buffer): string {
    return Buffer.from(encodedBytes).toString("base64");
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    this.stopAudioPlaybackLoop();
    if (this.instance) {
      try {
        if (typeof this.instance.endCall === "function")
          this.instance.endCall(0, false);
      } catch {}
    }
    for (const worker of this.runningWorkers) {
      try {
        worker.terminate();
      } catch {}
    }
    for (const worker of this.unusedWorkers) {
      try {
        worker.terminate();
      } catch {}
    }
    this.runningWorkers = [];
    this.unusedWorkers = [];
    this.pthreads = {};
    this.instance = null;
    this.vmContext = null;
    this.moduleRegistry.clear();
    this.wasmModule = null;
    this.wasmMemory = null;
    this.initialized = false;
  }

  initVoipStack(selfJid: string, meUserJid: string, selfLid: string): void {
    this.ensureInitialized();
    if (this.voipStackInitialized || this.voipStackInitPromise) return;

    this.voipStackInitPromise = new Promise<void>((resolve) => {
      try {
        const result = this.instance.initVoipStack(
          selfJid,
          meUserJid,
          selfLid,
          true,
          5,
          0,
          8,
          16
        );
        setTimeout(() => {
          this.voipStackInitialized = true;
          this.voipStackInitPromise = null;
          resolve();
        }, 3000);
      } catch (error) {
        this.voipStackInitPromise = null;
        resolve();
      }
    });
  }

  async waitForVoipStackReady(): Promise<void> {
    if (this.voipStackInitialized) return;
    if (this.voipStackInitPromise) await this.voipStackInitPromise;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }

  isVoipStackReady(): boolean {
    return this.voipStackInitialized;
  }

  makeStringList(arr: string[]) {
    const list = new this.instance.StringList();
    for (const v of arr) list.push_back(v);
    return list;
  }

  startCall(options: StartCallOptions) {
    this.ensureInitialized();
    const result = this.instance.startVoipCall(
      options.peerJid,
      this.makeStringList(options.peerList!),
      options.callId,
      0,
      options.peerPn,
      1,
      0,
      new this.instance.Uint8List()
    );
    return result;
  }

  startGroupCall(options: {
    peerJids: string[];
    pendingPeerJids: string[];
    inviteePeerJids: string[];
    callId: string;
    isVideo: boolean;
    selfJid: string;
    isAudioOnly: boolean;
    groupJid: string;
    callCreatorJid: string;
    isForcedRejoin: boolean;
    isVideoConference: boolean;
    epochId?: number;
    callLinkInviteeCount?: number;
    callLinkToken?: string;
  }): number {
    this.ensureInitialized();
    if (
      !this.voipStackInitialized ||
      typeof this.instance.startVoipGroupCall !== "function"
    )
      return -1;

    const peerJids = this.createStringList(options.peerJids);
    const pendingPeerJids = this.createStringList(options.pendingPeerJids);
    const inviteePeerJids = this.createStringList(options.inviteePeerJids);

    try {
      return this.instance.startVoipGroupCall(
        peerJids,
        pendingPeerJids,
        inviteePeerJids,
        options.callId,
        options.isVideo,
        options.selfJid,
        options.isAudioOnly,
        options.groupJid,
        options.callCreatorJid,
        options.isForcedRejoin,
        options.isVideoConference,
        options.epochId ?? 0,
        options.callLinkInviteeCount ?? 0,
        options.callLinkToken ?? ""
      );
    } finally {
      if (peerJids?.delete) peerJids.delete();
      if (pendingPeerJids?.delete) pendingPeerJids.delete();
      if (inviteePeerJids?.delete) inviteePeerJids.delete();
    }
  }

  acceptCall(callId: string, isVideo: boolean): void {
    this.ensureInitialized();
    this.instance.acceptCall(callId, isVideo);
  }

  rejectCall(): void {
    this.ensureInitialized();
    this.instance.rejectCall();
  }

  endCall(reason: number = 0, sendTerminate: boolean = true): void {
    this.ensureInitialized();
    this.instance.endCall(reason, sendTerminate);
  }

  getCallInfo(): CallInfo | null {
    this.ensureInitialized();
    const result = this.instance.getCallInfo();
    if (!result || result === "") return null;
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  handleSignalingAck(msg: SignalingMessage): void {
    this.ensureInitialized();
    const options = this.createUint8List(msg.extraData);
    try {
      this.instance.handleIncomingSignalingAck(
        msg.payload,
        "0",
        msg.msgType || "offer",
        msg.peerJid || "",
        options
      );
    } finally {
      if (options?.delete) options.delete();
    }
  }

  handleSignalingMessage(msg: {
    payload: string;
    peerPlatform?: string | number;
    peerAppVersion?: string;
    epochId?: string;
    timestamp?: string;
    isOffline?: boolean;
    peerJid: string;
    tcToken?: Uint8Array;
  }): void {
    this.ensureInitialized();
    const tcTokenList = this.createUint8List(msg.tcToken);
    try {
      this.instance.handleIncomingSignalingMessage(
        msg.payload,
        String(msg.peerPlatform ?? ""),
        String(msg.peerAppVersion ?? ""),
        "0",
        String(msg.timestamp ?? "0"),
        msg.isOffline ?? false,
        String(msg.peerJid),
        tcTokenList
      );
    } finally {
      if (tcTokenList?.delete) tcTokenList.delete();
    }
  }

  handleSignalingOffer(msg: {
    payload: string;
    peerPlatform?: number;
    peerAppVersion?: string;
    epochId?: string;
    timestamp?: string;
    isOffline?: boolean;
    isContact?: boolean;
    peerJid: string;
    tcToken?: Uint8Array;
  }): void {
    this.ensureInitialized();
    const tcTokenList = this.createUint8List(msg.tcToken);
    try {
      this.instance.handleIncomingSignalingOffer(
        msg.payload,
        String(msg.peerPlatform ?? 0),
        String(msg.peerAppVersion ?? "0"),
        String(msg.epochId ?? "0"),
        String(msg.timestamp ?? "0"),
        msg.isOffline ?? false,
        msg.isContact ?? true,
        String(msg.peerJid),
        tcTokenList
      );
    } finally {
      if (tcTokenList?.delete) tcTokenList.delete();
    }
  }

  handleRelayMessage(data: Uint8Array, ip: string, port: number): void {
    this.ensureInitialized();
    const FAUX_WEB_CLIENT_RELAY_PORT = 3478;
    const dataList = this.createUint8List(data);
    try {
      this.instance.handleOnMessage(dataList, ip, FAUX_WEB_CLIENT_RELAY_PORT);
    } finally {
      if (dataList?.delete) dataList.delete();
    }
  }

  handleSignalingReceipt(msg: {
    payload: string;
    peerJid: string;
    tcToken?: Uint8Array;
  }): void {
    this.ensureInitialized();
    const tcTokenList = this.createUint8List(msg.tcToken);
    try {
      if (typeof this.instance.handleIncomingSignalingReceipt === "function") {
        this.instance.handleIncomingSignalingReceipt(
          msg.payload,
          msg.peerJid,
          tcTokenList
        );
      }
    } finally {
      if (tcTokenList?.delete) tcTokenList.delete();
    }
  }

  resendOfferOnDecryptionFailure(peerJid: string, callId: string): void {
    this.ensureInitialized();
    if (typeof this.instance.resendOfferOnDecryptionFailure === "function") {
      this.instance.resendOfferOnDecryptionFailure(peerJid, callId);
    }
  }

  resendEncRekeyRetry(peerJid: string, callId: string): void {
    this.ensureInitialized();
    if (typeof this.instance.resendEncRekeyRetry === "function") {
      this.instance.resendEncRekeyRetry(peerJid, callId);
    }
  }

  handleOnTransportMessage(data: Uint8Array, ip: string, port: number): void {
    this.ensureInitialized();
    const dataList = this.createUint8List(data);
    try {
      this.instance.handleOnMessage(dataList, ip, port);
    } finally {
      if (dataList?.delete) dataList.delete();
    }
  }

  handleSignOut(): void {
    if (this.instance && typeof this.instance.handleSignOut === "function") {
      this.instance.handleSignOut();
    }
  }

  joinOngoingCall(options: {
    callId: string;
    groupJid: string;
    callCreatorJid: string;
    peerJids: string[];
    pendingPeerJids: string[];
    inviteePeerJids: string[];
    isVideo: boolean;
    selfJid: string;
    isAudioOnly: boolean;
    offerBytes: Uint8Array | null;
    groupSize: number;
    invitedByJid: string;
    isVideoConference: boolean;
    isForcedRejoin: boolean;
    epochId: number;
    tcToken?: Uint8Array;
  }): number {
    this.ensureInitialized();
    if (
      !this.voipStackInitialized ||
      typeof this.instance.joinVoipOngoingCall !== "function"
    )
      return -1;

    const peerJids = this.createStringList(options.peerJids);
    const pendingPeerJids = this.createStringList(options.pendingPeerJids);
    const inviteePeerJids = this.createStringList(options.inviteePeerJids);

    try {
      return this.instance.joinVoipOngoingCall(
        options.callId,
        options.groupJid,
        options.callCreatorJid,
        peerJids,
        pendingPeerJids,
        inviteePeerJids,
        options.isVideo,
        options.selfJid,
        options.isAudioOnly,
        options.offerBytes,
        options.groupSize,
        options.invitedByJid,
        options.isVideoConference,
        true,
        options.epochId,
        options.tcToken ? options.tcToken.length : 0
      );
    } finally {
      if (peerJids?.delete) peerJids.delete();
      if (pendingPeerJids?.delete) pendingPeerJids.delete();
      if (inviteePeerJids?.delete) inviteePeerJids.delete();
    }
  }

  rejectCallWithoutCallContext(
    peerJid: string,
    callId: string,
    callCreator: string,
    reason: number,
    peerDevice: string,
    isGroupCall: boolean,
    isVideoCall: boolean
  ): void {
    this.ensureInitialized();
    if (typeof this.instance.rejectCallWithoutCallContext === "function") {
      this.instance.rejectCallWithoutCallContext(
        peerJid,
        callId,
        callCreator,
        reason,
        peerDevice,
        isGroupCall,
        isVideoCall
      );
    }
  }

  setMute(muted: boolean): number {
    this.ensureInitialized();
    if (!this.getCallInfo()) return -1;
    return this.instance.setCallMute(muted);
  }

  setVideoMute(muted: boolean): number {
    this.ensureInitialized();
    if (!this.getCallInfo()) return -1;
    return this.instance.setCallVideoMute(muted);
  }

  requestVideoUpgrade(): number {
    this.ensureInitialized();
    return this.instance.requestVideoUpgrade();
  }

  acceptPeerVideo(peerJid: string): number {
    this.ensureInitialized();
    return this.instance.acceptPeerVideo(peerJid);
  }

  startScreenShare(): number {
    this.ensureInitialized();
    return this.instance.startScreenShare();
  }

  stopScreenShare(): number {
    this.ensureInitialized();
    return this.instance.stopScreenShare();
  }

  sendAudioData(data: Float32Array, ptr: number): void {
    this.ensureInitialized();
    if (!data || data.length === 0 || !ptr || ptr === 0) return;
    if (typeof this.instance.onAudioDataFromJs !== "function") return;

    try {
      const heapF32 = this.instance.GROWABLE_HEAP_F32?.();
      if (!heapF32) return;
      const index = Math.floor(ptr / 4);
      if (index < 0 || index + data.length > heapF32.length) return;
      heapF32.set(data, index);
      this.instance.onAudioDataFromJs(ptr, data.length);
    } catch {}
  }

  requestAudioData(
    playbackBuffer?: number,
    size?: number
  ): Float32Array | null {
    this.ensureInitialized();
    if (typeof this.instance.requestAudioDataFromWasmVoip !== "function")
      return null;

    try {
      if (playbackBuffer === undefined || size === undefined) {
        return this.instance.requestAudioDataFromWasmVoip();
      }

      this.instance.requestAudioDataFromWasmVoip(playbackBuffer, size);
      const heapF32 = this.instance.GROWABLE_HEAP_F32?.();
      if (!heapF32) return null;

      const index = Math.floor(playbackBuffer / 4);
      const numFloats = Math.floor(size / 4);
      if (index < 0 || index + numFloats > heapF32.length) return null;

      return new Float32Array(
        heapF32.buffer,
        heapF32.byteOffset + index * 4,
        numFloats
      );
    } catch {
      return null;
    }
  }

  private startAudioPlaybackLoop(): void {
    if (this.audioPlaybackLoopInterval) return;
    this.ensureInitialized();
    this.isPlaybackActive = true;

    if (typeof this.instance.requestAudioDataFromWasmVoip !== "function")
      return;

    const framesPerChunk = 320;
    const bufferSize = framesPerChunk * 4;

    try {
      const _malloc = this.instance._malloc || this.instance.malloc;
      if (_malloc) this.audioPlaybackBuffer = _malloc(bufferSize);
      else return;
    } catch {
      return;
    }

    if (!this.audioPlaybackBuffer || this.audioPlaybackBuffer <= 0) return;

    this.audioPlaybackLoopInterval = setInterval(() => {
      if (!this.isPlaybackActive || !this.instance || !this.initialized) {
        this.stopAudioPlaybackLoop();
        return;
      }

      try {
        const audioData = this.requestAudioData(
          this.audioPlaybackBuffer!,
          bufferSize
        );
        if (audioData && audioData.length > 0) {
          const hasNonZero = audioData.some(
            (sample) => Math.abs(sample) > 0.0001
          );
          if (hasNonZero && this.config.callbacks?.onAudioPlaybackData) {
            this.config.callbacks.onAudioPlaybackData(audioData);
          }
        }
      } catch {}
    }, 16);
  }

  private stopAudioPlaybackLoop(): void {
    this.isPlaybackActive = false;
    if (this.audioPlaybackLoopInterval) {
      clearInterval(this.audioPlaybackLoopInterval);
      this.audioPlaybackLoopInterval = null;
    }
    if (this.audioPlaybackBuffer && this.audioPlaybackBuffer > 0) {
      try {
        const _free = this.instance?._free || this.instance?.free;
        if (_free) _free(this.audioPlaybackBuffer);
      } catch {}
      this.audioPlaybackBuffer = null;
    }
  }

  sendVideoFrame(data: Uint8Array): void {
    this.ensureInitialized();
    if (typeof this.instance.onVideoDataFromJs === "function") {
      this.instance.onVideoDataFromJs(data);
    }
  }

  malloc(size: number): number {
    this.ensureInitialized();
    return this.instance._malloc(size);
  }

  free(ptr: number): void {
    this.ensureInitialized();
    this.instance._free(ptr);
  }

  writeToMemory(data: Uint8Array, ptr: number): void {
    this.ensureInitialized();
    this.instance.writeArrayToMemory(data, ptr);
  }

  get HEAP8(): Int8Array {
    return this.instance?.HEAP8;
  }
  get HEAPU8(): Uint8Array {
    return this.instance?.HEAPU8;
  }
  get HEAP16(): Int16Array {
    return this.instance?.HEAP16;
  }
  get HEAPU16(): Uint16Array {
    return this.instance?.HEAPU16;
  }
  get HEAP32(): Int32Array {
    return this.instance?.HEAP32;
  }
  get HEAPU32(): Uint32Array {
    return this.instance?.HEAPU32;
  }
  get HEAPF32(): Float32Array {
    return this.instance?.HEAPF32;
  }
  get HEAPF64(): Float64Array {
    return this.instance?.HEAPF64;
  }

  get GROWABLE_HEAP_F32(): Float32Array | null {
    if (this.instance?.GROWABLE_HEAP_F32)
      return this.instance.GROWABLE_HEAP_F32();
    return null;
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.instance) {
      throw new Error(
        "WhatsAppVoipWasm não foi inicializado. Chame initialize() primeiro."
      );
    }
  }

  private log(
    level: "error" | "warn" | "log" | "debug",
    message: string
  ): void {
    if (!this.config.enableLogs) return;
    this.config.callbacks?.onLog?.(level, message) ?? "";
  }

  private createStringList(items: string[]): any {
    if (!this.instance?.StringList) return null;
    const list = new this.instance.StringList();
    items.forEach((item) => list.push_back(item));
    return list;
  }

  private createUint8List(data?: Uint8Array): any {
    if (!this.instance?.Uint8List) return null;
    const list = new this.instance.Uint8List();
    if (data) data.forEach((byte) => list.push_back(byte));
    return list;
  }

  private allocateUnusedWorker(): void {
    const workerScriptPath = path.join(__dirname, "worker-bootstrap.js");
    if (!fs.existsSync(workerScriptPath)) return;

    try {
      const worker = new Worker(workerScriptPath, {
        stdout: true,
        stderr: true,
        workerData: {
          wasmPath: this.config.wasmPath,
          workerModulesCode: this.workerModulesCode,
          loaderCode: this.loaderCode,
          resourcesPath: this.config.resourcesPath,
          enableLogs: this.config.enableLogs,
        },
      });

      const port = new NodeWorkerMessagePort(worker, "WAWebVoipWebWasmWorker");

      if (worker.stdout)
        worker.stdout.on("data", (data: Buffer) => process.stdout.write(data));
      if (worker.stderr)
        worker.stderr.on("data", (data: Buffer) => process.stderr.write(data));

      this.unusedWorkers.push(port);
    } catch {}
  }

  private registerGlobalCallbacks(): void {
    const callbacks = this.config.callbacks || {};
    const self = this;

    WhatsAppVoipWasm.registerGlobalCallbackListener(
      "loggingCallback",
      (data: any) => {
        if (!self.config.enableLogs) return;
        const level = data?.level;
        const msg = data?.message || "";
        if (level === 1) self.log("error", msg);
        else if (level === 2) self.log("warn", msg);
        else if (level === 3) self.log("log", msg);
        else self.log("debug", msg);
      }
    );

    if (callbacks.onAudioCaptureInit) {
      WhatsAppVoipWasm.registerGlobalCallbackListener(
        "initCaptureDriverJS",
        (data: any) => {
          callbacks.onAudioCaptureInit!({
            sampleRate: data?.sample_rate || data?.sampleRate,
            channels: data?.channels,
            bitsPerSample: data?.bits_per_sample || data?.bitsPerSample,
            framesPerChunk: data?.frames_per_chunk || data?.framesPerChunk,
          });
        }
      );
    }

    WhatsAppVoipWasm.registerGlobalCallbackListener("startCaptureJS", () => {
      if (callbacks.onAudioCaptureStart) callbacks.onAudioCaptureStart();
    });

    WhatsAppVoipWasm.registerGlobalCallbackListener("stopCaptureJS", () => {
      if (callbacks.onAudioCaptureStop) callbacks.onAudioCaptureStop();
    });

    if (callbacks.onAudioPlaybackInit) {
      WhatsAppVoipWasm.registerGlobalCallbackListener(
        "initPlaybackDriverJS",
        (data: any) => {
          callbacks.onAudioPlaybackInit!({
            sampleRate: data?.sample_rate || data?.sampleRate,
            channels: data?.channels,
            bitsPerSample: data?.bits_per_sample || data?.bitsPerSample,
            framesPerChunk: data?.frames_per_chunk || data?.framesPerChunk,
          });
        }
      );
    }

    WhatsAppVoipWasm.registerGlobalCallbackListener("startPlaybackJS", () => {
      if (callbacks.onAudioPlaybackStart) callbacks.onAudioPlaybackStart();
      this.startAudioPlaybackLoop();
    });

    WhatsAppVoipWasm.registerGlobalCallbackListener("stopPlaybackJS", () => {
      this.stopAudioPlaybackLoop();
      if (callbacks.onAudioPlaybackStop) callbacks.onAudioPlaybackStop();
    });

    if (callbacks.onAudioPlaybackData) {
      WhatsAppVoipWasm.registerGlobalCallbackListener(
        "receiveAudioDataFromWasm",
        (data: any) => {
          let audioData: Float32Array | null = null;
          if (data?.audioData) {
            if (Array.isArray(data.audioData))
              audioData = new Float32Array(data.audioData);
            else if (data.audioData instanceof Float32Array)
              audioData = data.audioData;
            else if (
              data.audioData instanceof Uint8Array ||
              Buffer.isBuffer(data.audioData)
            ) {
              const buffer = Buffer.isBuffer(data.audioData)
                ? data.audioData
                : Buffer.from(data.audioData);
              audioData = new Float32Array(
                buffer.buffer,
                buffer.byteOffset,
                buffer.length / 4
              );
            }
          }
          if (
            audioData &&
            audioData.length > 0 &&
            callbacks.onAudioPlaybackData
          ) {
            callbacks.onAudioPlaybackData(audioData);
          }
        }
      );
    }

    if (callbacks.onSignalingXmpp) {
      WhatsAppVoipWasm.registerGlobalCallbackListener(
        "onSignalingXmpp",
        (data: any) => {
          const peerJid = data.peerJid || data.args?.peerJid;
          const callId = data.callId || data.args?.callId;
          let xmlPayload = data.xmlPayload || data.args?.xmlPayload;
          if (Array.isArray(xmlPayload))
            xmlPayload = new Uint8Array(xmlPayload);
          else if (
            xmlPayload &&
            typeof xmlPayload === "object" &&
            !(xmlPayload instanceof Uint8Array) &&
            !Buffer.isBuffer(xmlPayload)
          ) {
            xmlPayload = new Uint8Array(xmlPayload);
          }
          callbacks.onSignalingXmpp!(peerJid, callId, xmlPayload);
        }
      );
    }

    if (callbacks.onCallEvent) {
      WhatsAppVoipWasm.registerGlobalCallbackListener(
        "onCallEvent",
        (data: any) => {
          const eventType = data.eventType;
          const eventDataJson = data.eventDataJson;

          if (eventType === 16 && eventDataJson) {
            try {
              const callInfo =
                typeof eventDataJson === "string"
                  ? JSON.parse(eventDataJson)
                  : eventDataJson;
              let callState =
                callInfo?.call_info?.callState ||
                callInfo?.call_info?.call_state ||
                callInfo?.callState ||
                callInfo?.call_state;
              if (callState === 0 || callState === 13)
                this.stopAudioPlaybackLoop();
            } catch {}
          } else if (eventType === 2) {
            this.stopAudioPlaybackLoop();
          }

          callbacks.onCallEvent!(eventType, eventDataJson);
        }
      );
    }

    if (callbacks.sendDataToRelay) {
      WhatsAppVoipWasm.registerGlobalCallbackListener(
        "sendDataToRelay",
        (data: any) => {
          let relayData = data.data || data.args?.data;
          const ip = data.ip || data.args?.ip;
          const portNum = data.port || data.args?.port;

          if (relayData instanceof Uint8Array) {
            // OK
          } else if (Array.isArray(relayData)) {
            relayData = new Uint8Array(relayData);
          } else if (Buffer.isBuffer(relayData)) {
            relayData = new Uint8Array(relayData);
          } else if (
            relayData &&
            typeof relayData === "object" &&
            relayData.buffer
          ) {
            relayData = new Uint8Array(
              relayData.buffer,
              relayData.byteOffset || 0,
              relayData.byteLength || relayData.length
            );
          } else if (relayData instanceof ArrayBuffer) {
            relayData = new Uint8Array(relayData);
          } else {
            return 0;
          }

          if (!ip || !portNum) return 0;
          if (callbacks.sendDataToRelay)
            callbacks.sendDataToRelay(relayData, ip, portNum);
          return relayData.byteLength;
        }
      );
    }

    WhatsAppVoipWasm.globalCallbacksRegistered = true;
  }

  private loadWasmModuleToWorker(worker: NodeWorkerMessagePort): Promise<void> {
    return new Promise((resolve) => {
      const loadedHandler = (msg: any) => {
        if (msg && msg.cmd === "loaded") {
          worker.removeMessageListener("cmd", loadedHandler);
          this.workersLoadedCount++;
          if (
            this.workersLoadedCount >= this.pthreadPoolSize &&
            this.removeRunDependencyCallback
          ) {
            this.removeRunDependencyCallback("loading-workers");
          }
          resolve();
        }
      };
      worker.addMessageListener("cmd", loadedHandler);
      worker.workerID = this.nextWorkerID++;

      worker.postMessage({
        cmd: "load",
        type: "cmd",
        wasmMemory: this.wasmMemory,
        wasmModule: this.wasmModule,
        workerID: worker.workerID,
        handlers: [],
      });
    });
  }

  private async loadWasmModuleToAllWorkers(): Promise<void> {
    this.workersLoadedCount = 0;
    const promises = this.unusedWorkers.map((w) =>
      this.loadWasmModuleToWorker(w)
    );
    await Promise.all(promises);
  }

  private getNewWorker(): NodeWorkerMessagePort | null {
    if (this.unusedWorkers.length === 0) {
      this.allocateUnusedWorker();
      if (this.unusedWorkers.length === 0) return null;
      const newWorker = this.unusedWorkers[0];
      this.loadWasmModuleToWorker(newWorker);
    }
    return this.unusedWorkers.pop()!;
  }

  private returnWorkerToPool(worker: NodeWorkerMessagePort): void {
    const ptr = worker.pthread_ptr;
    delete this.pthreads[ptr];
    this.unusedWorkers.push(worker);
    this.runningWorkers = this.runningWorkers.filter((w) => w !== worker);
    worker.pthread_ptr = 0;
  }

  private async initPThreadPool(): Promise<void> {
    for (let i = 0; i < this.pthreadPoolSize; i++) this.allocateUnusedWorker();
  }

  private requireModule(name: string): any {
    const self = this;

    const preDefinedModules: Record<string, any> = {
      Promise: Promise,
      WAWebVoipWebWasmWorkerResource: {
        resourcePath: path.join(__dirname, "worker-bootstrap.js"),
        name: "WAWebVoipWebWasmWorker",
      },
      WorkerBundleResource: {
        createDedicatedWebWorker: (resource: any) => {
          const scriptPath =
            resource.resourcePath ||
            path.join(__dirname, "worker-bootstrap.js");
          const worker = new Worker(scriptPath, {
            stdout: true,
            stderr: true,
            workerData: {
              wasmPath: self.config.wasmPath,
              workerModulesCode: self.workerModulesCode,
              loaderCode: self.loaderCode,
              resourcesPath: self.config.resourcesPath,
              enableLogs: self.config.enableLogs,
            },
          });
          if (worker.stdout)
            worker.stdout.on("data", (data: Buffer) =>
              process.stdout.write(data)
            );
          if (worker.stderr)
            worker.stderr.on("data", (data: Buffer) =>
              process.stderr.write(data)
            );
          return worker;
        },
      },
      WorkerClient: { init: () => {} },
      WorkerMessagePort: {
        WorkerMessagePort: NodeWorkerMessagePort,
        CastWorkerMessagePort: (worker: any) => worker,
        WorkerSyncedMessagePort: NodeWorkerMessagePort,
      },
      bx: Object.assign((id: string | number) => String(id), {
        getURL: () => "",
      }),
      HasteSupportData: { handle: () => {} },
      ServiceWorkerDynamicModules: { handle: () => {} },
      WhatsAppWebServiceWorker: { default: true },
      WAWebLogger: { initializeWAWebLogger: () => {} },
      WAWebSw: { initHandlers: () => {} },
      WAWebWamRuntimeProvider: { setWamRuntime: () => {} },
      WAWebWamWorkerInterface: { commit: () => {}, set: () => {} },
      ServerJSDefine: { handleDefine: () => {} },
      ix: { add: () => {} },
      MetaConfigMap: { add: () => {} },
      QPLHasteSupportDataStorage: {
        default: { add: () => {}, get: () => null },
      },
      getFalcoLogPolicy_DO_NOT_USE: { add: () => {} },
      gkx: { add: () => {} },
      justknobx: { add: () => {} },
      qex: { add: () => {} },
    };

    if (preDefinedModules[name]) return preDefinedModules[name];

    const mod = this.moduleRegistry.get(name);
    if (!mod) return {};
    if (mod.exports !== undefined) return mod.exports;

    const exports: Record<string, any> = {};
    const module = { exports };
    const resolvedDeps = mod.deps.map((dep) => this.requireModule(dep));
    const args: any[] = [
      globalThis,
      this.requireModule.bind(this),
      this.requireModule.bind(this),
      this.requireModule.bind(this),
      module,
      exports,
      ...resolvedDeps,
    ];

    try {
      mod.factory(...args);
    } catch {}

    let result = module.exports;
    if (
      result &&
      typeof result === "object" &&
      "exports" in result &&
      Object.keys(result).length === 1
    ) {
      result = (result as any).exports;
    }
    mod.exports = result;
    return result;
  }

  private createAtomicsWrapper(memory: WebAssembly.Memory): typeof Atomics {
    const atomicsWrapper = {
      add: Atomics.add.bind(Atomics),
      and: Atomics.and.bind(Atomics),
      compareExchange: Atomics.compareExchange.bind(Atomics),
      exchange: Atomics.exchange.bind(Atomics),
      isLockFree: Atomics.isLockFree.bind(Atomics),
      load: Atomics.load.bind(Atomics),
      or: Atomics.or.bind(Atomics),
      store: Atomics.store.bind(Atomics),
      sub: Atomics.sub.bind(Atomics),
      xor: Atomics.xor.bind(Atomics),

      notify: (
        typedArray: Int32Array,
        index: number,
        count?: number
      ): number => {
        try {
          return Atomics.notify(typedArray, index, count);
        } catch (e: any) {
          if (
            e?.message?.includes("futex_wake") ||
            e?.message?.includes("main_browser_thread")
          )
            return 0;
          throw e;
        }
      },

      waitAsync: (Atomics as any).waitAsync
        ? (Atomics as any).waitAsync.bind(Atomics)
        : () => ({ async: true, value: Promise.resolve("ok" as const) }),

      wait: (
        typedArray: Int32Array,
        index: number,
        value: number,
        timeout?: number
      ): "ok" | "not-equal" | "timed-out" => {
        const currentValue = Atomics.load(typedArray, index);
        if (currentValue !== value) return "not-equal";
        if (timeout !== undefined && timeout <= 0) return "timed-out";
        return "timed-out";
      },

      [Symbol.toStringTag]: "Atomics",
    };
    return atomicsWrapper as unknown as typeof Atomics;
  }

  private createVMContext(memory: WebAssembly.Memory): vm.Context {
    const self = this;
    const callbacks = this.config.callbacks || {};

    const wasmCallbacks = {
      onVoipReady: () => {
        if (self.voipReadyResolver) self.voipReadyResolver();
        callbacks.onVoipReady?.();
      },
      onSignalingXmpp: (data: any) => {
        callbacks.onSignalingXmpp?.(
          data?.peerJid,
          data?.callId,
          data?.xmlPayload
        );
      },
      onCallEvent: (data: any) => {
        callbacks.onCallEvent?.(data?.eventType, data?.eventDataJson);
      },
      sendDataToRelay: (data: any) => {
        callbacks.sendDataToRelay?.(data?.data, data?.ip, data?.port);
      },
      loggingCallback: (data: any) => {
        if (!self.config.enableLogs) return;
        const level = data?.level,
          msg = data?.message || "";
        if (level === 1) self.log("error", msg);
        else if (level === 2) self.log("warn", msg);
        else if (level === 3) self.log("log", msg);
        else self.log("debug", msg);
      },
      initCaptureDriverJS: (data: any) => {
        callbacks.onAudioCaptureInit?.({
          sampleRate: data?.sample_rate,
          channels: data?.channels,
          bitsPerSample: data?.bits_per_sample,
          framesPerChunk: data?.frames_per_chunk,
        });
        return 0;
      },
      startCaptureJS: () => {
        callbacks.onAudioCaptureStart?.();
        return 0;
      },
      stopCaptureJS: () => {
        callbacks.onAudioCaptureStop?.();
        return 0;
      },
      initPlaybackDriverJS: (data: any) => {
        callbacks.onAudioPlaybackInit?.({
          sampleRate: data?.sample_rate,
          channels: data?.channels,
          bitsPerSample: data?.bits_per_sample,
          framesPerChunk: data?.frames_per_chunk,
        });
        return 0;
      },
      startPlaybackJS: () => {
        callbacks.onAudioPlaybackStart?.();
        return 0;
      },
      stopPlaybackJS: () => {
        callbacks.onAudioPlaybackStop?.();
        return 0;
      },
      startVideoCaptureJS: (data: any) => {
        callbacks.onVideoCaptureStart?.({
          cameraId: data?.camera_id,
          width: data?.width,
          height: data?.height,
          maxFps: data?.max_fps,
        });
        return 0;
      },
      stopVideoCaptureJS: () => {
        callbacks.onVideoCaptureStop?.();
        return 0;
      },
      onVideoFrameWasmToJs: (data: any) => {
        callbacks.onVideoFrame?.({
          userJid: data?.userJid,
          frameBuffer: data?.frameBuffer,
          width: data?.width,
          height: data?.height,
          orientation: data?.orientation,
          format: data?.format,
          timestamp: data?.timestamp,
          isKeyFrame: data?.isKeyFrame,
        });
      },
      startDesktopCaptureJS: () => 0,
      stopDesktopCaptureJS: () => 0,
      cryptoHkdfExtractWithSaltAndExpand: (data: any) => {
        const toByteArray = (input: any): Uint8Array => {
          if (!input) return new Uint8Array(0);
          if (input instanceof Uint8Array) return input;
          if (typeof input === "string") return new TextEncoder().encode(input);
          if (ArrayBuffer.isView(input))
            return new Uint8Array(
              input.buffer,
              input.byteOffset,
              input.byteLength
            );
          if (input instanceof ArrayBuffer) return new Uint8Array(input);
          if (typeof input === "object" && typeof input.length === "number") {
            const arr = new Uint8Array(input.length);
            for (let i = 0; i < input.length; i++) arr[i] = input[i] || 0;
            return arr;
          }
          return new Uint8Array(0);
        };
        const key = toByteArray(data?.key_);
        const salt = data?.salt_ ? toByteArray(data.salt_) : null;
        const info = toByteArray(data?.info_);
        const length = data?.length || 32;
        if (callbacks.cryptoHkdf)
          return callbacks.cryptoHkdf(key, salt, info, length);
        return new Uint8Array(length);
      },
      hmacSha256KeyGenerator: (data: any) => {
        if (callbacks.hmacSha256)
          return callbacks.hmacSha256(
            new Uint8Array(data?.data_),
            new Uint8Array(data?.key_)
          );
        return new Uint8Array(32);
      },
      isParticipantKnownContact: () => true,
      getPersistentDirectoryPath: () => {
        const voipStorageDir = "/tmp/voip";
        try {
          if (!fs.existsSync(voipStorageDir))
            fs.mkdirSync(voipStorageDir, { recursive: true });
        } catch {}
        return voipStorageDir;
      },
    };

    const __d = (name: string, deps: string[], factory: Function) => {
      this.moduleRegistry.set(name, { deps, factory, exports: undefined });
    };

    const babelHelpers = {
      extends: Object.assign,
      inheritsLoose: (subClass: any, superClass: any) => {
        subClass.prototype = Object.create(superClass.prototype);
        subClass.prototype.constructor = subClass;
        subClass.__proto__ = superClass;
      },
      objectWithoutPropertiesLoose: (source: any, excluded: string[]) => {
        if (source == null) return {};
        const target: any = {};
        for (const key of Object.keys(source)) {
          if (excluded.indexOf(key) >= 0) continue;
          target[key] = source[key];
        }
        return target;
      },
      taggedTemplateLiteralLoose: (
        strings: TemplateStringsArray,
        raw?: string[]
      ) => {
        if (!raw) raw = strings.slice(0) as unknown as string[];
        (strings as any).raw = raw;
        return strings;
      },
      wrapNativeSuper: (Class: any) => Class,
    };

    const addRunDependency = (dep: string) => {
      if (
        dep === "loading-workers" &&
        this.workersLoadedCount >= this.pthreadPoolSize
      ) {
        setImmediate(() => {
          if (this.removeRunDependencyCallback)
            this.removeRunDependencyCallback(dep);
        });
        return;
      }
      this.runDependencies.add(dep);
    };

    const removeRunDependency = (dep: string) => {
      this.runDependencies.delete(dep);
    };
    this.removeRunDependencyCallback = removeRunDependency;

    const selfObj: Record<string, any> = {
      __swData: { dynamic_data: { hsdp: {}, dynamic_modules: [] } },
      WhatsAppVoipWasmCallbacks: wasmCallbacks,
      WhatsAppVoipWasmWorkerCompatibleCallbacks: wasmCallbacks,
    };

    if (typeof global !== "undefined") {
      (global as any).WhatsAppVoipWasmCallbacks = wasmCallbacks;
      (global as any).WhatsAppVoipWasmWorkerCompatibleCallbacks = wasmCallbacks;
    }

    const context = vm.createContext({
      self: selfObj,
      globalThis: selfObj,
      global: selfObj,
      window: selfObj,
      console,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      queueMicrotask,
      performance,
      babelHelpers,
      __d,
      require: this.requireModule.bind(this),
      addRunDependency,
      removeRunDependency,
      WebAssembly,
      SharedArrayBuffer,
      Atomics: this.createAtomicsWrapper(memory),
      Int8Array,
      Uint8Array,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array,
      BigInt64Array,
      BigUint64Array,
      ArrayBuffer,
      DataView,
      Error,
      TypeError,
      RangeError,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Symbol,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      Date,
      JSON,
      RegExp,
      Function,
      Proxy,
      Reflect,
      crypto: {
        getRandomValues: (arr: Uint8Array) => {
          const randomBytes = require("crypto").randomBytes(arr.length);
          for (let i = 0; i < arr.length; i++) arr[i] = randomBytes[i];
          return arr;
        },
      },
      WhatsAppVoipWasmCallbacks: wasmCallbacks,
      WhatsAppVoipWasmWorkerCompatibleCallbacks: wasmCallbacks,
      navigator: { userAgent: "Mozilla/5.0 Node.js", hardwareConcurrency: 4 },
      document: { currentScript: null },
      location: { href: "file:///wasm" },
      Worker: class {
        constructor() {}
        postMessage() {}
        terminate() {}
        addEventListener() {}
      },
      fetch: async () => {
        throw new Error("fetch not supported");
      },
      XMLHttpRequest: class {
        open() {}
        send() {}
        setRequestHeader() {}
      },
      Blob: class {
        constructor() {}
      },
      URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
      Image: class {
        src = "";
        onload = null;
        onerror = null;
      },
      Audio: class {
        src = "";
        addEventListener() {}
      },
      __NODE_PTHREAD: {
        getUnusedWorker: () => {
          if (this.unusedWorkers.length === 0) return null;
          const worker = this.unusedWorkers.pop()!;
          this.runningWorkers.push(worker);
          return worker;
        },
        returnWorkerToPool: (worker: any) => {
          const idx = this.runningWorkers.indexOf(worker);
          if (idx >= 0) {
            this.runningWorkers.splice(idx, 1);
            this.unusedWorkers.push(worker);
          }
        },
        spawnThread: (params: any) => {
          const worker = this.unusedWorkers.pop();
          if (!worker) return 6;
          this.runningWorkers.push(worker);
          this.pthreads[params.pthread_ptr] = worker;
          worker.pthread_ptr = params.pthread_ptr;
          worker.postMessage({
            cmd: "run",
            start_routine: params.startRoutine,
            arg: params.arg,
            pthread_ptr: params.pthread_ptr,
          });
          return 0;
        },
        unusedWorkersCount: () => this.unusedWorkers.length,
        runningWorkersCount: () => this.runningWorkers.length,
      },
      __IS_NODE_PTHREAD_ENV: true,
    });

    context.self = context;
    context.globalThis = context;
    context.global = context;
    context.window = context;

    return context;
  }
}

export default WhatsAppVoipWasm;
