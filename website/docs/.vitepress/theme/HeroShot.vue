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
    <div class="glow" aria-hidden="true" />
    <a class="frame" :href="fullSize" target="_blank" rel="noopener" :title="shot.alt">
      <div class="chrome" aria-hidden="true">
        <span class="dot red" /><span class="dot amber" /><span class="dot green" />
        <span class="url">filebox · lab-server</span>
      </div>
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

.glow {
  position: absolute;
  inset: 6% 10% auto;
  height: 70%;
  border-radius: 50%;
  background: linear-gradient(120deg, rgba(99, 102, 241, 0.45), rgba(168, 85, 247, 0.35) 55%, rgba(14, 165, 233, 0.3));
  filter: blur(72px);
  opacity: 0.55;
  z-index: 0;
  pointer-events: none;
}
.dark .glow { opacity: 0.35; }

.frame {
  position: relative;
  z-index: 1;
  display: block;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.06),
    0 12px 28px -8px rgba(15, 23, 42, 0.18),
    0 32px 64px -24px rgba(79, 70, 229, 0.28);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
@media (min-width: 960px) {
  .frame { border-radius: 14px; }
  .frame:hover {
    transform: translateY(-2px);
    box-shadow:
      0 1px 2px rgba(15, 23, 42, 0.06),
      0 18px 36px -10px rgba(15, 23, 42, 0.22),
      0 40px 80px -28px rgba(79, 70, 229, 0.34);
  }
}

.chrome {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
}
@media (min-width: 640px) {
  .chrome { height: 34px; gap: 7px; padding: 0 14px; }
}
.dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
@media (min-width: 640px) { .dot { width: 11px; height: 11px; } }
.red { background: #ff5f57; }
.amber { background: #febc2e; }
.green { background: #28c840; }
.url {
  flex: 1;
  margin: 0 auto;
  max-width: 280px;
  margin-left: 12px;
  padding: 2px 10px;
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (max-width: 639px) { .url { max-width: 180px; } }

picture, img {
  display: block;
  width: 100%;
  height: auto;
}

.caption {
  position: relative;
  z-index: 1;
  margin: 14px auto 0;
  max-width: 720px;
  text-align: center;
  font-size: 13px;
  line-height: 20px;
  color: var(--vp-c-text-2);
}
.caption a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.caption a:hover { text-decoration: underline; }
</style>
