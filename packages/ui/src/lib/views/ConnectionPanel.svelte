<script lang="ts">
  import { connect } from '../api';

  let { onconnected }: { onconnected: () => void } = $props();

  let siteUrl = $state('');
  let username = $state('');
  let applicationPassword = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    const payload = { siteUrl, username, applicationPassword };
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
</script>

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

  <button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</form>
