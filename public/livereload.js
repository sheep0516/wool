/* 本地实时刷新：监听服务端的文件变化通知，自动刷新当前页面。
   reload         —— content/ views/ public/ 改动，刷新一下就能看到
   restart        —— server.js 改动，服务正在自我重启，等它回来再刷新
   server-changed —— server.js 改动，但当前没人托管，只能提示手动重启 */
(function () {
  if (!window.EventSource) return;

  var banner = null;

  function showBanner(text) {
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('role', 'status');
      banner.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:26px',
        'transform:translateX(-50%)',
        'z-index:9999',
        'max-width:90vw',
        'padding:9px 16px',
        'border-radius:8px',
        'background:#18181a',
        'color:#fff',
        'font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
        'box-shadow:0 10px 30px rgba(0,0,0,.3)',
        'pointer-events:none'
      ].join(';');
      document.body.appendChild(banner);
    }
    banner.textContent = text;
  }

  /* 服务重启期间请求会失败，所以轮询到通为止再刷新，
     免得刷出个「无法访问此网站」。 */
  function waitForServer(tries) {
    tries = tries || 0;
    fetch('/public/favicon.ico', { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('bad status');
        window.location.reload();
      })
      .catch(function () {
        if (tries > 25) {
          showBanner('服务还没回来，请手动刷新页面（F5）');
          return;
        }
        setTimeout(function () {
          waitForServer(tries + 1);
        }, 600);
      });
  }

  var source;

  function connect() {
    source = new EventSource('/events');

    source.onmessage = function (event) {
      var data = event.data;
      if (data === 'reload') {
        window.location.reload();
      } else if (data === 'restart') {
        showBanner('server.js 已改动，正在重启服务…');
        waitForServer();
      } else if (data === 'server-changed') {
        showBanner('server.js 已改动，需要重新运行 start.bat 才会生效');
      }
    };

    // 断线时交给浏览器自动重连，这里只做一次手动兜底
    source.onerror = function () {
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        setTimeout(connect, 1500);
      }
    };
  }

  connect();
})();
