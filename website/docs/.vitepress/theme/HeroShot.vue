<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { frontmatter } = useData()
const shot = computed(() => frontmatter.value.heroShot as
  | { alt: string; caption?: string; link?: string; linkText?: string }
  | undefined)

// Responsive WebP variants produced by scripts/capture-tabs.mjs.
const img = (name: string) => withBase(`/screenshots/${name}`)
const desktopSet = computed(() =>
  `${img('hero-tabs-pdf-1600.webp')} 1600w, ${img('hero-tabs-pdf-2400.webp')} 2400w`)
const mobileSet = computed(() =>
  `${img('hero-tabs-pdf-mobile-800.webp')} 800w, ${img('hero-tabs-pdf-mobile-1200.webp')} 1200w`)
const fullSize = computed(() => img('14-tabs-pdf.png'))
</script>

<template>
  <section v-if="shot" class="HeroShot" aria-label="Product screenshot">
    <a class="frame" :href="fullSize" target="_blank" rel="noopener" :title="shot.alt">
      <picture>
        <!-- Phones: tighter crop of the preview pane so tabs, heatmap and table stay legible. -->
        <source
          media="(max-width: 639px)"
          type="image/webp"
          :srcset="mobileSet"
          sizes="calc(100vw - 32px)"
          width="1200"
          height="1247"
        />
        <source
          type="image/webp"
          :srcset="desktopSet"
          sizes="(min-width: 1280px) 1152px, calc(100vw - 64px)"
          width="1600"
          height="1000"
        />
        <img
          :src="img('hero-tabs-pdf-1600.webp')"
          :alt="shot.alt"
          width="1600"
          height="1000"
          fetchpriority="high"
          decoding="async"
        />
      </picture>
    </a>
    <p v-if="shot.caption" class="caption">
      {{ shot.caption }}
      <template v-if="shot.link">
        · <a :href="withBase(shot.link)">{{ shot.linkText || 'Learn more' }} →</a>
      </template>
    </p>
  </section>
</template>

<style scoped>
.HeroShot {
  position: relative;
  margin: 0 auto;
  padding: 0 16px 8px;
  max-width: calc(1152px + 64px);
}
@media (min-width: 640px) {
  .HeroShot { padding: 0 32px 16px; }
}

.frame {
  display: block;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.08);
}
:global(.dark) .frame {
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.04);
}
.frame:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
}

picture, img {
  display: block;
  width: 100%;
  height: auto;
}

.caption {
  margin: 14px auto 0;
  max-width: 720px;
  text-align: center;
  font-size: 12px;
  line-height: 20px;
  color: var(--vp-c-text-3);
}
.caption a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
  white-space: nowrap;
}
.caption a:hover { color: var(--vp-c-brand-1); }
</style>
