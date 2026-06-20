<script lang="ts">
  import { connect, connectSaved, forget } from '../api';

  let {
    onconnected,
    canPersist = false,
    persisted = false,
    savedSiteUrl = null,
  }: {
    onconnected: () => void;
    canPersist?: boolean;
    persisted?: boolean;
    savedSiteUrl?: string | null;
  } = $props();

  let siteUrl = $state('');
  let username = $state('');
  let applicationPassword = $state('');
  let remember = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    const payload = { siteUrl, username, applicationPassword, remember };
    try {
      await connect(payload);
      onconnected();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      // Never keep the secret in browser state, even on failure (re-enter to retry).
      applicationPassword = '';
      busy = false;
    }
  }

  async function useSaved(): Promise<void> {
    busy = true;
    error = null;
    try {
      await connectSaved();
      onconnected();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function forgetSaved(): Promise<void> {
    busy = true;
    error = null;
    try {
      await forget();
      onconnected(); // refresh so the saved-connection prompt disappears
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if persisted && savedSiteUrl}
  <section class="saved-connection">
    <p>Saved connection: <strong>{savedSiteUrl}</strong></p>
    <div class="saved-actions">
      <button type="button" onclick={useSaved} disabled={busy}>
        {busy ? 'Connecting…' : 'Use saved connection'}
      </button>
      <button type="button" class="link" onclick={forgetSaved} disabled={busy}>Forget</button>
    </div>
  </section>
{/if}

<form class="connect" onsubmit={submit}>
  <h2>Connect to WordPress</h2>
  <p class="notice">
    Use an <a
      href="https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/"
      target="_blank"
      rel="noreferrer">Application Password</a
    >. Credentials are kept only in this session's local process, never in the browser.
  </p>

  <label>
    Site URL
    <input bind:value={siteUrl} placeholder="https://example.com" autocomplete="off" required />
  </label>
  <label>
    Username
    <input bind:value={username} autocomplete="off" required />
  </label>
  <label>
    Application Password
    <input type="password" bind:value={applicationPassword} autocomplete="off" required />
  </label>

  {#if canPersist}
    <label class="remember">
      <input type="checkbox" bind:checked={remember} />
      Remember this connection (stored securely in your OS Keychain)
    </label>
  {/if}

  <button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</form>
