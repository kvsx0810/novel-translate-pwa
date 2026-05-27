// metadata-worker.js — fetch + parse metadata.json off main thread
self.onmessage = async function(e) {
  const { url } = e.data;
  try {
    self.postMessage({ type: 'progress', text: 'Đang tải từ điển (65MB)...' });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // Stream + parse in chunks to avoid OOM
    self.postMessage({ type: 'progress', text: 'Đang parse JSON...' });
    const text = await resp.text();

    self.postMessage({ type: 'progress', text: 'Đang xử lý dữ liệu...' });
    const json = JSON.parse(text);

    if (!json.data?.importedDicts) throw new Error('metadata.json không đúng định dạng');

    self.postMessage({ type: 'done', data: json });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
