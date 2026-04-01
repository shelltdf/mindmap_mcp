(function () {
  const host = window.resolveMindmapHostBridge
    ? window.resolveMindmapHostBridge()
    : window.mindmapDesktop;
  const statusbar = document.getElementById('statusbar');
  const fileLabel = document.getElementById('fileLabel');
  const btnNew = document.getElementById('btnNew');
  const btnOpen = document.getElementById('btnOpen');
  const btnSave = document.getElementById('btnSave');
  const btnSaveAs = document.getElementById('btnSaveAs');

  let jm = null;
  let currentFilePath = '';
  let currentExt = 'mmd';
  let dirty = false;

  function setStatus(msg) {
    if (statusbar) statusbar.textContent = msg;
  }

  function updateFileLabel() {
    const suffix = dirty ? ' *' : '';
    const name = currentFilePath || `(untitled.${currentExt})`;
    if (fileLabel) fileLabel.textContent = name + suffix;
  }

  function toMindData(tree) {
    function walk(node) {
      return {
        id: node.id,
        topic: node.topic,
        children: (node.children || []).map(walk)
      };
    }
    return {
      meta: { name: 'mindmap', author: 'desktop', version: '1.0' },
      format: 'node_tree',
      data: walk(tree.root)
    };
  }

  function getTree() {
    if (!jm) throw new Error('mindmap not initialized');
    if (typeof jm.get_root === 'function') {
      const root = jm.get_root();
      if (root) return { root: normalize(root) };
    }
    if (typeof jm.get_data === 'function') {
      const data = jm.get_data('node_tree');
      if (data && data.data) return { root: normalize(data.data) };
    }
    throw new Error('unable to export tree');
  }

  function normalize(node) {
    return {
      id: node.id || ('n_' + Math.random().toString(16).slice(2)),
      topic: String(node.topic != null ? node.topic : ''),
      children: (node.children || []).map(normalize)
    };
  }

  function renderTree(tree) {
    jm = new jsMind({
      container: 'jsmind_container',
      editable: true,
      theme: 'primary',
      mode: 'full'
    });
    jm.show(toMindData(tree));
    jm.add_event_listener('edit_node', function () {
      dirty = true;
      updateFileLabel();
    });
    jm.add_event_listener('move_node', function () {
      dirty = true;
      updateFileLabel();
    });
  }

  function newTree() {
    return {
      root: { id: 'root', topic: 'New Mindmap', children: [] }
    };
  }

  async function doOpen() {
    const res = await host.openFile();
    if (!res || res.canceled) return;
    currentFilePath = res.filePath;
    currentExt = res.ext;
    dirty = false;
    updateFileLabel();
    renderTree(res.tree);
    setStatus('Opened: ' + currentFilePath);
  }

  async function doSave() {
    try {
      const tree = getTree();
      if (!currentFilePath) {
        await doSaveAs(tree);
        return;
      }
      const res = await host.save({ tree: tree, filePath: currentFilePath });
      if (res && res.ok) {
        dirty = false;
        currentExt = res.ext || currentExt;
        updateFileLabel();
        setStatus('Saved');
      }
    } catch (e) {
      setStatus('Save failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  async function doSaveAs(treeOverride) {
    try {
      const tree = treeOverride || getTree();
      const res = await host.saveAs({
        tree: tree,
        suggestedPath: currentFilePath,
        ext: currentExt
      });
      if (!res || res.canceled) return;
      currentFilePath = res.filePath;
      currentExt = res.ext;
      dirty = false;
      updateFileLabel();
      setStatus('Saved As: ' + currentFilePath);
    } catch (e) {
      setStatus('Save As failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  btnNew.addEventListener('click', function () {
    currentFilePath = '';
    currentExt = 'mmd';
    dirty = false;
    updateFileLabel();
    renderTree(newTree());
    setStatus('New mindmap');
  });
  btnOpen.addEventListener('click', function () {
    void doOpen();
  });
  btnSave.addEventListener('click', function () {
    void doSave();
  });
  btnSaveAs.addEventListener('click', function () {
    void doSaveAs();
  });

  renderTree(newTree());
  updateFileLabel();
  setStatus('Ready');
})();
