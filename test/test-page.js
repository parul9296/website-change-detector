// Local demo page for testing: noise changes on every load, real content changes on /bump
// Run: npm run test-page   then watch http://localhost:4000 (start the app with ALLOW_PRIVATE=1)
const http = require('http');
let version = 1, views = 1000;
http.createServer((req, res) => {
  if (req.url === '/bump') { version++; res.end(`Content is now version ${version}`); return; }
  if (req.url === '/captcha') { res.end('<html><title>Just a moment...</title><body>Verify you are human</body></html>'); return; }
  views += Math.floor(Math.random() * 50);
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><html><head><title>Notice board</title></head><body style="font-family:sans-serif">
    <h1>College Notice Board</h1>
    <p id="clock">Last updated: ${new Date().toLocaleTimeString()} on ${new Date().toLocaleDateString()}</p>
    <div class="ad-banner">Random ad #${Math.random().toString(36).slice(2)}</div>
    <p class="counter">${views} views</p>
    <div id="notices"><h2>Notices</h2><p>Exam schedule: version ${version}</p>
      ${version > 1 ? '<p>NEW: Lab exam moved to Friday.</p>' : ''}</div>
    <p>Session token: ${Math.random().toString(36).slice(2)}${Date.now().toString(36)}abc123XYZ</p>
  </body></html>`);
}).listen(4000, () => console.log('Test page on http://localhost:4000 (open /bump to change content)'));
