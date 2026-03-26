<script lang="ts">
  import "../app.css"; // Importamos los estilos globales
  import { t } from '$lib/i18n/index.js';

</script>
  
  <svelte:head>
	<title>{$t('layout.title')}</title>
  </svelte:head>

  <slot />