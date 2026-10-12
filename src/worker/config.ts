import { z } from 'zod';

type Config = {
  mode: 'test' | 'production';
  authMode: 'mock' | 'line';
  messagingMode: 'mock' | 'line' | 'disabled';
  appOrigin: string;
};

export function readConfig(env: Record<string, string | undefined>): Config {
  const mode = z.enum(['test', 'production']).parse(env.APP_MODE ?? 'test');
  const authMode = z.enum(['mock', 'line']).parse(env.AUTH_MODE ?? 'mock');
  const messagingMode = z.enum(['mock', 'line', 'disabled']).parse(env.MESSAGING_MODE ?? 'mock');
  if (mode === 'production' && (authMode === 'mock' || messagingMode === 'mock')) {
    throw new Error('Production must not use mock auth or messaging');
  }
  const appOrigin = env.APP_ORIGIN ?? 'http://localhost:5173';
  const url = new URL(appOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== appOrigin || url.username || url.password) {
    throw new Error('APP_ORIGIN must be a valid HTTP(S) origin without a path');
  }
  if (mode === 'production' && url.protocol !== 'https:') {
    throw new Error('Production APP_ORIGIN must use HTTPS');
  }
  if (mode === 'production') {
    readLiffConfig(env);
    if (env.LINE_CHANNEL_SECRET !== undefined) readAuthConfig(env);
  }
  return { mode, authMode, messagingMode, appOrigin };
}

type IdentityEnv = { AUTH_MODE?: string; APP_ORIGIN?: string; LINE_CHANNEL_ID?: string; LINE_PROVIDER_ID?: string; LINE_CHANNEL_SECRET?: string };

/** Optional ordinary-browser OAuth requires its own secret; LIFF does not. */
export function readAuthConfig(env:IdentityEnv){
 if(env.AUTH_MODE!==undefined&&env.AUTH_MODE!=='line')throw new Error('Real identity cannot use mock auth');
 const appOrigin=z.url().parse(env.APP_ORIGIN);const url=new URL(appOrigin);
 if(url.protocol!=='https:'||url.origin!==appOrigin||url.username||url.password)throw new Error('LINE authentication requires exact HTTPS origin');
 const channelId=z.string().regex(/^\d{1,30}$/).parse(env.LINE_CHANNEL_ID);
 const providerId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(env.LINE_PROVIDER_ID);
 const channelSecret=z.string().min(1).max(256).parse(env.LINE_CHANNEL_SECRET);
 return{appOrigin,channelId,provider:`line:${providerId}`,channelSecret};
}

/** LIFF token verification needs only the public Login channel and provider IDs. */
export function readLiffConfig(env: IdentityEnv) {
  if (env.AUTH_MODE !== 'line') throw new Error('LINE identity must be explicitly enabled');
  const appOrigin = z.url().parse(env.APP_ORIGIN);
  const url = new URL(appOrigin);
  if (url.protocol !== 'https:' || url.origin !== appOrigin || url.username || url.password) throw new Error('Exact HTTPS origin required');
  const channelId = z.string().regex(/^\d{1,30}$/).parse(env.LINE_CHANNEL_ID);
  const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(env.LINE_PROVIDER_ID);
  return { appOrigin, channelId, provider: `line:${providerId}` };
}
