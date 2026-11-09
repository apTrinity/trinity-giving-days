// Which copy of the server may renew the Blackbaud (SKY) login and run the background jobs that use it.
//
// Blackbaud swaps in a new refresh token every time a login is renewed, so only ONE running copy of the server
// should ever do that. The deployed server (Render sets RENDER=true) does. A copy started on a laptop, which
// shares the same database and the same saved login, must not: if it renewed the login, the deployed server
// would be left holding a refresh token that no longer works and every payment capture would fail.
// To run the background jobs somewhere else on purpose, set SKY_BACKGROUND=on there.
module.exports = {
  backgroundAllowed: () => !!process.env.RENDER || String(process.env.SKY_BACKGROUND || '').toLowerCase() === 'on',
};
