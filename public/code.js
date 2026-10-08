/* 代码块：复制按钮（点一下把代码原样复制到剪贴板） */
(function () {
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // 优先用剪贴板 API；被拒（未聚焦 / 无权限 / 非 https）时退回 execCommand
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function flash(btn, text, done) {
    clearTimeout(btn.__t);
    btn.textContent = text;
    btn.classList.toggle('is-done', !!done);
    btn.__t = setTimeout(function () {
      btn.textContent = '复制';
      btn.classList.remove('is-done');
    }, 1600);
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('.code-copy');
    if (!btn) return;

    var block = btn.closest('.code-block');
    var code = block && block.querySelector('pre code');
    if (!code) return;

    copyText(code.innerText.replace(/\n$/, '')).then(
      function () {
        flash(btn, '已复制', true);
      },
      function () {
        flash(btn, '复制失败', false);
      }
    );
  });
})();
