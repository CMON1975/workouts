import { putDraft, deleteDraft } from './idb.js';
import { api } from './api.js';
import { enqueueFailedPatch, clearShadow } from './persistence.js';

export const STATES = Object.freeze({
  DRAFT: 'draft',
  DIRTY: 'dirty',
  SAVING: 'saving',
  SAVED: 'saved',
  FINALIZING: 'finalizing',
  FINALIZED: 'finalized',
});

export function createSessionState({ draft, onChange }) {
  let state = STATES.DRAFT;
  const emit = () => onChange?.({ state, draft });

  let inputDebounce;
  let networkDebounce;
  const INPUT_DEBOUNCE_MS = 400;
  const NETWORK_DEBOUNCE_MS = 1500;

  function setState(next) {
    if (state === next) return;
    state = next;
    emit();
  }

  async function persistLocal() {
    // Sync shadow first (cheap and fast).
    try { localStorage.setItem('draft:' + draft.id, JSON.stringify(draft)); } catch (_) {}
    try { await putDraft(draft); } catch (_) {}
  }

  async function pushToServer() {
    setState(STATES.SAVING);
    try {
      await api.patchDraft(draft.id, draft);
      setState(STATES.SAVED);
    } catch (err) {
      await enqueueFailedPatch(draft);
      setState(STATES.DIRTY);
    }
  }

  function scheduleNetworkFlush() {
    clearTimeout(networkDebounce);
    networkDebounce = setTimeout(pushToServer, NETWORK_DEBOUNCE_MS);
  }

  function onInput(mutator) {
    mutator(draft);
    draft.client_version += 1;
    draft.updated_at = Date.now();
    setState(STATES.DIRTY);

    clearTimeout(inputDebounce);
    inputDebounce = setTimeout(async () => {
      await persistLocal();
      scheduleNetworkFlush();
    }, INPUT_DEBOUNCE_MS);
  }

  async function flushNow() {
    clearTimeout(inputDebounce);
    clearTimeout(networkDebounce);
    await persistLocal();
    await pushToServer();
  }

  async function finalize() {
    await flushNow();
    setState(STATES.FINALIZING);
    try {
      const res = await api.finalize(draft.id, draft.client_version);
      draft.finalized_at = res.finalized_at;
      await deleteDraft(draft.id);
      clearShadow(draft.id);
      setState(STATES.FINALIZED);
      return res;
    } catch (err) {
      setState(STATES.SAVED);
      throw err;
    }
  }

  function getDraft() { return draft; }
  function getState() { return state; }

  return { onInput, flushNow, finalize, getDraft, getState };
}
