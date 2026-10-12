// Local browser fixture only. This entry is never reachable from the production graph.
// It runs the real production shell/API/components; SDK identity and HTTP replies
// are explicitly synthetic seams controlled by Playwright, not OAuth proof.
import { createRoot } from 'react-dom/client';
import { App } from '../../src/web/production';
import '../../src/web/styles.css';

type BrowserFixture = { loggedIn?: boolean; holdInit?: boolean; token?: string; initUrl?: string; returnUrl?: string; releaseInit?: () => void };
declare global { interface Window { adminBrowserFixture: BrowserFixture } }
const state = window.adminBrowserFixture ?? (window.adminBrowserFixture = {});
const sdk = {
  async init() { state.initUrl = location.href; if (state.holdInit) await new Promise<void>(resolve => { state.releaseInit = resolve; }); },
  isLoggedIn: () => state.loggedIn !== false,
  isInClient: () => false,
  getIDToken: () => state.token ?? 'synthetic-browser-id-token',
  login: ({ redirectUri }: { redirectUri: string }) => { state.returnUrl = redirectUri; },
  logout: () => { state.loggedIn = false; },
  closeWindow: () => {},
};
createRoot(document.getElementById('root')!).render(<App config={{ liffId: '12345-synthetic', staging: true, origin: 'https://synthetic-browser.example' }} loadSdk={async () => sdk} />);
