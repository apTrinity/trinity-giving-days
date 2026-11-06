// Admin-only, read-only: runs a saved Raiser's Edge query (default 648898) through the SKY Query API and reports
// what comes back: the column names, the row count and the first few rows. Writes nothing anywhere.
// Runs inside the server so it uses the server's own Blackbaud login (and renews it safely).

const axios = require('axios');
const { parse } = require('csv-parse/sync');

module.exports = function mountQueryTest(app, { requireAdmin, skyRequest }) {
  let run = { state: 'idle' };

  async function execute(id) {
    const t0 = Date.now();
    run = { state: 'running', query_id: id, started: new Date().toISOString() };
    try {
      const ex = await skyRequest({ method: 'post', url: 'https://api.sky.blackbaud.com/query/queries/executebyid', params: { product: 'RE', module: 'None' }, data: { id } });
      const jobId = ex.data && ex.data.id;
      if (!jobId) throw new Error('Blackbaud did not return a job for query ' + id);
      let sas = null, last = '';
      for (let i = 0; i < 60 && !sas; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const j = await skyRequest({ method: 'get', url: 'https://api.sky.blackbaud.com/query/jobs/' + jobId, params: { product: 'RE', module: 'None', include_read_url: 1 } });
        last = (j.data && j.data.status) || '';
        if (last === 'Completed') sas = j.data.sas_uri;
        else if (['Failed', 'Cancelled'].includes(last)) throw new Error('The RE query job ' + last.toLowerCase() + '.');
      }
      if (!sas) throw new Error('The RE query took longer than 4 minutes (last status: ' + last + ').');
      const csv = (await axios.get(sas, { responseType: 'text' })).data;
      const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
      const headers = rows.length ? Object.keys(rows[0]) : [];
      // How full each column is, so you can see at a glance what is usable.
      const filled = {};
      for (const h of headers) filled[h] = rows.reduce((n, r) => n + (String(r[h] || '').trim() ? 1 : 0), 0);
      run = { state: 'done', query_id: id, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), rows: rows.length, headers, filled, sample: rows.slice(0, 3) };
    } catch (err) {
      const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 300)}` : (err.message || String(err));
      console.error('[GD query test] failed:', detail);
      run = { state: 'error', query_id: id, error: detail };
    }
  }

  app.post('/api/admin/gd/query-test/start', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A test is already running.' });
    const id = parseInt(req.body && req.body.query_id, 10) || 648898;
    execute(id);
    res.status(202).json({ started: true });
  });
  app.get('/api/admin/gd/query-test/status', requireAdmin, (req, res) => res.json(run));
};
