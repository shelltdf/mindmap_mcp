(function () {
  function createElectronBridge() {
    if (!window.mindmapDesktop) return null;
    return {
      openFile: function () {
        return window.mindmapDesktop.openFile();
      },
      save: function (payload) {
        return window.mindmapDesktop.save(payload);
      },
      saveAs: function (payload) {
        return window.mindmapDesktop.saveAs(payload);
      }
    };
  }

  function createNoopBridge() {
    return {
      openFile: async function () {
        return { canceled: true };
      },
      save: async function () {
        return { ok: false, reason: 'host bridge unavailable' };
      },
      saveAs: async function () {
        return { canceled: true };
      }
    };
  }

  window.resolveMindmapHostBridge = function () {
    return createElectronBridge() || createNoopBridge();
  };
})();
