const https = require('https');
const crypto = require('crypto');

let electronNet = null;
try { electronNet = require('electron').net; } catch {}

const ESPLORA = [
  'https://blockstream.info/api',
  'https://mempool.space/api',
];
const BLOCKCYPHER = 'https://api.blockcypher.com/v1/btc/main';
const BLOCKCHAIN = 'https://blockchain.info';

const TX_PAGE = 50;
const TX_OUT_CAP = 200;
const ADDR_SPEND_CAP = 12;
const ADDR_TX_PAGES = 2;
const REQUEST_MS = 8000;

let onProgress = () => {};
function setProgress(fn) { onProgress = typeof fn === 'function' ? fn : () => {}; }

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function get(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      try { req?.abort?.(); req?.destroy?.(); } catch {}
      finish(reject, Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    }, REQUEST_MS);

    const handleBody = (status, raw) => {
      if (status === 429) {
        return finish(reject, Object.assign(new Error('Rate limit exceeded (HTTP 429)'), { code: 429 }));
      }
      if (status >= 400) {
        let msg = raw?.slice?.(0, 180) || `HTTP ${status}`;
        try { const j = JSON.parse(raw); msg = j.error || j.message || msg; } catch {}
        return finish(reject, new Error(msg));
      }
      if (!raw) return finish(resolve, null);
      try { finish(resolve, JSON.parse(raw)); }
      catch { finish(reject, new Error(`Non-JSON response (HTTP ${status})`)); }
    };

    if (electronNet?.request) {
      try {
        req = electronNet.request({ url, method: 'GET' });
        req.setHeader('User-Agent', 'BTC-Tracer/1.0');
        req.setHeader('Accept', 'application/json');
        let raw = '';
        req.on('response', res => {
          res.on('data', c => { raw += c; });
          res.on('end', () => handleBody(res.statusCode, raw));
          res.on('error', err => finish(reject, err));
        });
        req.on('error', err => finish(reject, err));
        req.end();
        return;
      } catch (e) {
        // fall through to Node https
      }
    }

    req = https.get(url, {
      headers: { 'User-Agent': 'BTC-Tracer/1.0', Accept: 'application/json' },
      timeout: REQUEST_MS,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => handleBody(res.statusCode, raw));
    });
    req.on('error', err => finish(reject, err));
    req.on('timeout', () => { req.destroy(); finish(reject, Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })); });
  });
}

async function getRetry(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await get(url); }
    catch (e) {
      lastErr = e;
      if (e.code === 429) await sleep(1200);
    }
  }
  throw lastErr;
}

function hostName(url) {
  try { return new URL(url).host; } catch { return url; }
}

async function esploraPath(path) {
  let lastErr;
  for (const base of ESPLORA) {
    onProgress(`Contacting ${hostName(base)}…`);
    try {
      return { base, data: await getRetry(base + path, 1) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All blockchain APIs failed');
}

function isSpendingRef(r) {
  return typeof r.tx_input_n === 'number' && r.tx_input_n >= 0;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58encode(buf) {
  let hex = buf.toString('hex');
  if (!hex) return '';
  let x = BigInt('0x' + hex);
  let out = '';
  while (x > 0n) {
    out = B58[Number(x % 58n)] + out;
    x = x / 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function p2pkhFromPubkey(pubkeyHex) {
  const pub = Buffer.from(pubkeyHex, 'hex');
  if (pub.length !== 33 && pub.length !== 65) return null;
  const sha = crypto.createHash('sha256').update(pub).digest();
  const ripe = crypto.createHash('ripemd160').update(sha).digest();
  const payload = Buffer.concat([Buffer.from([0x00]), ripe]);
  const cs = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  return b58encode(Buffer.concat([payload, cs]));
}

function addressFromScript(o) {
  if (o?.scriptpubkey_address) return o.scriptpubkey_address;
  const asm = o?.scriptpubkey_asm || '';
  const type = o?.scriptpubkey_type || '';
  if (type === 'p2pk' || type === 'pubkey' || /\bOP_CHECKSIG\b/.test(asm)) {
    const m = asm.match(/\b([0-9a-fA-F]{66}|[0-9a-fA-F]{130})\b/);
    if (m) return p2pkhFromPubkey(m[1]);
  }
  return null;
}

async function fetchTxEsplora(txid) {
  const { base, data: tx } = await esploraPath(`/tx/${txid}`);
  if (!tx || !tx.txid) throw new Error(`Transaction not found: ${txid}`);
  onProgress(`Loading outputs for ${txid.slice(0, 12)}…`);
  let spends = [];
  try { spends = await getRetry(base + `/tx/${txid}/outspends`, 1); }
  catch { spends = []; }
  const spendList = Array.isArray(spends) ? spends : [];
  return {
    hash: tx.txid,
    block: tx.status?.block_height ?? -1,
    confirmed: tx.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
    fees: tx.fee ?? 0,
    inputs: (tx.vin || []).map(i => ({
      address: addressFromScript(i.prevout) ?? i.prevout?.scriptpubkey_address ?? null,
      value:   i.prevout?.value ?? 0,
    })),
    outputs: (tx.vout || []).map((o, i) => ({
      address: addressFromScript(o),
      value:   o.value ?? 0,
      spentBy: spendList[i]?.spent ? spendList[i].txid : null,
    })),
  };
}

async function fetchTxBlockCypher(txid) {
  onProgress('Trying BlockCypher…');
  let outstart = 0;
  let first = null;
  const allOutputs = [];

  while (outstart < TX_OUT_CAP) {
    const data = await getRetry(
      `${BLOCKCYPHER}/txs/${txid}?limit=${TX_PAGE}&outstart=${outstart}&includeHex=false`,
      1
    );
    if (data?.error) throw new Error(`API: ${data.error}`);
    if (!first) first = data;
    const page = data.outputs || [];
    allOutputs.push(...page);
    const total = data.vout_sz ?? allOutputs.length;
    if (allOutputs.length >= total || page.length === 0) break;
    outstart = allOutputs.length;
  }

  return {
    hash:      first.hash,
    block:     first.block_height,
    confirmed: first.confirmed,
    fees:      first.fees,
    inputs: (first.inputs || []).map(i => ({
      address: i.addresses?.[0] ?? null,
      value:   i.output_value ?? 0,
    })),
    outputs: allOutputs.map(o => ({
      address: o.addresses?.[0] ?? null,
      value:   o.value ?? 0,
      spentBy: o.spent_by ?? null,
    })),
  };
}

async function fetchTxBlockchain(txid) {
  onProgress('Trying blockchain.info…');
  const data = await getRetry(`${BLOCKCHAIN}/rawtx/${txid}`, 1);
  if (!data?.hash && !data?.txid) throw new Error('Transaction not found');
  return {
    hash: data.hash || txid,
    block: data.block_height ?? -1,
    confirmed: null,
    fees: data.fee ?? 0,
    inputs: (data.inputs || []).map(i => ({
      address: i.prev_out?.addr ?? null,
      value:   i.prev_out?.value ?? 0,
    })),
    outputs: (data.out || []).map(o => ({
      address: o.addr ?? null,
      value:   o.value ?? 0,
      spentBy: null,
    })),
  };
}

async function fetchTx(txid) {
  try {
    const tx = await fetchTxEsplora(txid);
    if ((tx.outputs || []).some(o => o.address) || !(tx.outputs || []).length) return tx;
    try { return await fetchTxBlockCypher(txid); } catch { return tx; }
  } catch (e1) {
    try { return await fetchTxBlockCypher(txid); }
    catch (e2) {
      try { return await fetchTxBlockchain(txid); }
      catch { throw new Error(e1.message || 'Could not load transaction'); }
    }
  }
}

async function fetchAddressTxsEsplora(address) {
  const { base, data: info } = await esploraPath(`/address/${address}`);
  const chain = info.chain_stats || {};
  const mempool = info.mempool_stats || {};
  const balance = (chain.funded_txo_sum - chain.spent_txo_sum)
    + ((mempool.funded_txo_sum || 0) - (mempool.spent_txo_sum || 0));
  const txCount = (chain.tx_count || 0) + (mempool.tx_count || 0);

  onProgress('Loading recent transactions…');
  const txs = [];
  let page = await getRetry(base + `/address/${address}/txs`, 1);
  let pages = 0;
  while (Array.isArray(page) && page.length && pages < ADDR_TX_PAGES) {
    txs.push(...page);
    pages++;
    const spendsFound = txs.filter(tx =>
      (tx.vin || []).some(v => (addressFromScript(v.prevout) || v.prevout?.scriptpubkey_address) === address)
    ).length;
    if (spendsFound >= ADDR_SPEND_CAP) break;
    if (page.length < 25) break;
    const last = page[page.length - 1].txid;
    page = await getRetry(base + `/address/${address}/txs/chain/${last}`, 1);
  }

  const allSpends = [...new Set(
    txs
      .filter(tx => (tx.vin || []).some(v => (addressFromScript(v.prevout) || v.prevout?.scriptpubkey_address) === address))
      .map(tx => tx.txid)
  )];

  return {
    hashes:      allSpends.slice(0, ADDR_SPEND_CAP),
    balance,
    totalRecv:   chain.funded_txo_sum || 0,
    hasSpending: allSpends.length > 0,
    spentCount:  chain.spent_txo_count || 0,
    truncated:   txCount > txs.length,
    spendCapHit: allSpends.length > ADDR_SPEND_CAP,
  };
}

async function fetchAddressTxsBlockCypher(address) {
  onProgress('Trying BlockCypher address index…');
  const data = await getRetry(`${BLOCKCYPHER}/addrs/${address}?limit=50&unspentOnly=false`, 1);
  if (data?.error) throw new Error(`API: ${data.error}`);
  const refs = [...(data.txrefs || []), ...(data.unconfirmed_txrefs || [])];
  const allSpends = [...new Set(refs.filter(isSpendingRef).map(r => r.tx_hash))];
  return {
    hashes:      allSpends.slice(0, ADDR_SPEND_CAP),
    balance:     data.final_balance ?? data.balance ?? 0,
    totalRecv:   data.total_received ?? 0,
    hasSpending: allSpends.length > 0,
    truncated:   data.hasMore === true,
    spendCapHit: allSpends.length > ADDR_SPEND_CAP,
  };
}

async function fetchAddressTxsBlockchain(address) {
  onProgress('Trying blockchain.info…');
  const data = await getRetry(`${BLOCKCHAIN}/rawaddr/${address}?limit=50`, 1);
  const txs = data.txs || [];
  const allSpends = [...new Set(
    txs
      .filter(tx => (tx.inputs || []).some(i => i.prev_out?.addr === address))
      .map(tx => tx.hash)
  )];
  return {
    hashes:      allSpends.slice(0, ADDR_SPEND_CAP),
    balance:     data.final_balance ?? 0,
    totalRecv:   data.total_received ?? 0,
    hasSpending: allSpends.length > 0,
    truncated:   (data.n_tx || 0) > txs.length,
    spendCapHit: allSpends.length > ADDR_SPEND_CAP,
  };
}

async function fetchAddressTxs(address) {
  try {
    const info = await fetchAddressTxsEsplora(address);
    if (info.hasSpending) return info;
    if ((info.spentCount || 0) > 0 || info.truncated) {
      try {
        const fallback = await fetchAddressTxsBlockCypher(address);
        if (fallback.hasSpending) return { ...fallback, truncated: true };
      } catch {}
    }
    return info;
  } catch (e) {
    try { return await fetchAddressTxsBlockchain(address); }
    catch {
      try { return await fetchAddressTxsBlockCypher(address); }
      catch (e2) { throw new Error(e2.message || e.message || 'Could not load address'); }
    }
  }
}

module.exports = {
  fetchTx,
  fetchAddressTxs,
  setProgress,
  TX_OUT_CAP,
};
