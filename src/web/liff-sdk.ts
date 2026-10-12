import liff from '@line/liff/core';
import Login from '@line/liff/login';
import Logout from '@line/liff/logout';
import GetIDToken from '@line/liff/get-id-token';
import IsLoggedIn from '@line/liff/is-logged-in';
import IsInClient from '@line/liff/is-in-client';
import CloseWindow from '@line/liff/close-window';

// Official pluggable SDK: install before init. No analytics, profile or messaging modules.
// The SDK owns its standard browser token storage; application code does not persist tokens.
liff.use(new Login());
liff.use(new Logout());
liff.use(new GetIDToken());
liff.use(new IsLoggedIn());
liff.use(new IsInClient());
liff.use(new CloseWindow());
export default liff;
