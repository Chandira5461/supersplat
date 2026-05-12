// QC mode — added by the GSplat fork.
//
// When the editor is opened with ?scene_id=<id>&token=<firebase-id-token>:
//   1. Inject a floating panel (top-right) with property tag + status/action button.
//   2. Auto-fetch the raw splat from S3 via our API's qc-url endpoint and
//      dispatch the editor's import event with the resulting bytes as
//      `contents`. We can NOT pass the signed URL via upstream's ?load= flow:
//      AWS pre-signed URLs contain `/` characters in `X-Amz-Credential=.../
//      <date>/<region>/s3/aws4_request`, which trips up splat-transform's
//      `stripQueryAndHash` (it does lastIndexOf('/') on the whole string
//      before stripping query params, so basename detection finds the wrong
//      slash and the URL never gets its `.ply` extension recognized).
//   3. On "Save Cleaned" click: serialize visible splats via the existing
//      serializePlyCompressed, mint a fresh signed PUT URL, PUT the bytes,
//      PATCH the property's status to 'cleaned'.
//
// All UI additions are floating DOM elements with the `gsplat-` id prefix,
// keeping zero footprint on upstream's PCUI panel tree for clean future merges.

import { MemoryFileSystem } from '@playcanvas/splat-transform';

import type { Events } from '../events';
import { serializePlyCompressed } from '../splat-serialize';
import type { Splat } from '../splat';

type QcParams = {
    scene_id: string;
    token: string;
    apiBaseUrl: string;
};

const readQcParams = (): QcParams | null => {
    const url = new URL(location.href);
    const scene_id = url.searchParams.get('scene_id');
    const token = url.searchParams.get('token');
    if (!scene_id || !token) return null;
    return {
        scene_id,
        token,
        apiBaseUrl: url.searchParams.get('api') ?? 'http://localhost:4000'
    };
};

const fetchQcUrl = async (params: QcParams): Promise<{ get_url: string; put_url: string; expires_in: number }> => {
    const res = await fetch(`${params.apiBaseUrl}/properties/${params.scene_id}/qc-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${params.token}` }
    });
    if (!res.ok) {
        throw new Error(`qc-url request failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
};

const patchStatus = async (params: QcParams, status: string): Promise<void> => {
    const res = await fetch(`${params.apiBaseUrl}/properties/${params.scene_id}`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
    });
    if (!res.ok) {
        throw new Error(`PATCH status failed: ${res.status} ${await res.text()}`);
    }
};

const saveCleaned = async (params: QcParams, events: Events): Promise<{ bytes: number }> => {
    const splats = events.invoke('scene.splats') as Splat[];
    if (!splats || splats.length === 0) {
        throw new Error('No splats loaded yet — load a scene first');
    }

    const { put_url } = await fetchQcUrl(params);

    const memFs = new MemoryFileSystem();
    await serializePlyCompressed(splats, { minOpacity: 1 / 255, removeInvalid: true }, memFs);
    const data = memFs.results.get('output.compressed.ply');
    if (!data) {
        throw new Error('Serialize produced no output');
    }

    const putRes = await fetch(put_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Blob([data as BlobPart], { type: 'application/octet-stream' })
    });
    if (!putRes.ok) {
        throw new Error(`S3 PUT failed: ${putRes.status} ${await putRes.text()}`);
    }

    await patchStatus(params, 'cleaned');

    return { bytes: data.byteLength };
};

const STYLE = `
    #gsplat-qc-panel {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 10000;
        display: flex;
        gap: 8px;
        align-items: center;
        background: rgba(20, 20, 22, 0.95);
        backdrop-filter: blur(8px);
        padding: 8px 12px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #e4e4e7;
    }
    #gsplat-qc-panel .gsplat-scene-tag {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 11px;
        color: #a1a1aa;
        padding-right: 8px;
        border-right: 1px solid #3f3f46;
    }
    #gsplat-qc-save {
        padding: 6px 14px;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
    }
    #gsplat-qc-save:hover:not(:disabled) { background: #1d4ed8; }
    #gsplat-qc-save:disabled { opacity: 0.6; cursor: progress; }
    #gsplat-qc-save.gsplat-ok { background: #10b981 !important; }
    #gsplat-qc-save.gsplat-err { background: #dc2626 !important; }
`;

const injectStyle = () => {
    if (document.getElementById('gsplat-qc-style')) return;
    const s = document.createElement('style');
    s.id = 'gsplat-qc-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
};

const buildPanel = (params: QcParams, onSave: () => void) => {
    injectStyle();
    const panel = document.createElement('div');
    panel.id = 'gsplat-qc-panel';

    const tag = document.createElement('span');
    tag.className = 'gsplat-scene-tag';
    tag.textContent = params.scene_id.slice(0, 8);
    panel.appendChild(tag);

    const btn = document.createElement('button');
    btn.id = 'gsplat-qc-save';
    btn.textContent = 'Save Cleaned';
    btn.addEventListener('click', onSave);
    panel.appendChild(btn);

    document.body.appendChild(panel);
    return btn;
};

const setState = (btn: HTMLButtonElement, text: string, css?: 'ok' | 'err' | '') => {
    btn.textContent = text;
    btn.classList.remove('gsplat-ok', 'gsplat-err');
    if (css === 'ok') btn.classList.add('gsplat-ok');
    if (css === 'err') btn.classList.add('gsplat-err');
};

const loadSplat = async (params: QcParams, events: Events, btn: HTMLButtonElement) => {
    btn.disabled = true;
    setState(btn, 'Fetching splat…');
    const t0 = performance.now();
    try {
        const { get_url } = await fetchQcUrl(params);
        const res = await fetch(get_url);
        if (!res.ok) {
            throw new Error(`S3 GET failed: ${res.status} ${res.statusText}`);
        }
        const buffer = await res.arrayBuffer();
        const mb = (buffer.byteLength / 1024 / 1024).toFixed(1);
        console.log(`[gsplat-qc] fetched ${mb} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s; importing…`);
        setState(btn, `Loading ${mb} MB…`);

        // Dispatch into upstream's import flow. Because `contents` is set, the
        // file-handler uses our `filename` ('raw.ply') for format detection
        // rather than trying to extension-sniff the signed URL.
        //
        // Wrap in a File (which extends Blob) — upstream's MappedReadFileSystem
        // calls `.arrayBuffer()` on contents downstream, so a raw Uint8Array
        // fails. File matches upstream's drag-drop / PWA-launch flows that
        // also pass File objects.
        const file = new File([buffer], 'raw.ply', { type: 'application/octet-stream' });
        await events.invoke('import', [{
            filename: 'raw.ply',
            contents: file
        }]);

        setState(btn, 'Save Cleaned', '');
        btn.disabled = false;
    } catch (err) {
        const msg = (err as Error).message;
        console.error('[gsplat-qc] load failed:', err);
        setState(btn, 'Load failed', 'err');
        window.alert(`Load failed:\n${msg}`);
        // Leave the button disabled — there's nothing to save until the user reloads the page.
    }
};

const initGSplatQcMode = (events: Events) => {
    const params = readQcParams();
    if (!params) {
        console.log('[gsplat-qc] no scene_id/token in URL — QC mode off, plain editor.');
        return;
    }
    console.log(`[gsplat-qc] QC mode active for property ${params.scene_id} (api ${params.apiBaseUrl})`);

    let btn!: HTMLButtonElement;
    const onSaveClick = async () => {
        btn.disabled = true;
        setState(btn, 'Saving…');
        try {
            const { bytes } = await saveCleaned(params, events);
            setState(btn, `Saved · ${(bytes / 1024 / 1024).toFixed(1)} MB`, 'ok');
            console.log(`[gsplat-qc] saved cleaned splat (${bytes} bytes) + status flipped to 'cleaned'`);
            setTimeout(() => { setState(btn, 'Save Cleaned', ''); btn.disabled = false; }, 4000);
        } catch (err) {
            const msg = (err as Error).message;
            console.error('[gsplat-qc] save failed:', err);
            setState(btn, 'Save failed', 'err');
            window.alert(`Save failed:\n${msg}`);
            setTimeout(() => { setState(btn, 'Save Cleaned', ''); btn.disabled = false; }, 4000);
        }
    };

    btn = buildPanel(params, onSaveClick);

    // Auto-load the splat. setTimeout so the panel renders first.
    setTimeout(() => { loadSplat(params, events, btn); }, 50);
};

export { initGSplatQcMode };
