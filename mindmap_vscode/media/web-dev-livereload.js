/** 仅本地 run_web.py / out/web_dev.html 使用：轮询 out/web_dev_meta.json 触发整页刷新。 */
(function () {
  var lastSeq = null;
  function tick() {
    fetch('/out/web_dev_meta.json?cb=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var s = typeof d.seq === 'number' ? d.seq : 0;
        if (lastSeq === null) lastSeq = s;
        else if (s > lastSeq) {
          lastSeq = s;
          location.reload();
        }
      })
      .catch(function () {});
  }
  setInterval(tick, 600);
})();
