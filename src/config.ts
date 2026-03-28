export interface AppConfig {
  port: number
  voipServiceToken: string
}

export const appConfig: AppConfig = {
  port: parseInt(process.env.PORT || '3097', 10),
  voipServiceToken: process.env.VOIP_SERVICE_TOKEN || '',
}
