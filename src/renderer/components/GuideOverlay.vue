<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 使用引导。
 *
 * 引导内容随产品能力走（发现 → 管理 → 编排 → 监测 → 日志），
 * 关闭后不再自动弹出，但顶栏常驻入口可以随时再次打开。
 */
defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);
const { t } = useI18n();

const steps = computed(() => [
  { icon: '🔍', title: t('guide.step1Title'), text: t('guide.step1Text') },
  { icon: '🧩', title: t('guide.step2Title'), text: t('guide.step2Text') },
  { icon: '🔗', title: t('guide.step3Title'), text: t('guide.step3Text') },
  { icon: '📈', title: t('guide.step4Title'), text: t('guide.step4Text') },
  { icon: '📜', title: t('guide.step5Title'), text: t('guide.step5Text') },
]);
</script>

<template>
  <div
    v-if="open"
    style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: grid; place-items: center; padding: 24px; z-index: 60"
    @click.self="emit('close')"
  >
    <section class="panel" style="width: 580px; max-width: 100%; max-height: 82vh; overflow: auto">
      <div class="panel-title">
        <span>📖</span>
        <span class="flex-1">{{ t('guide.title') }}</span>
        <button class="ghost icon" :title="t('guide.close')" @click="emit('close')">✕</button>
      </div>

      <div class="panel-body col">
        <div class="text-12 muted">{{ t('guide.intro') }}</div>

        <div v-for="step in steps" :key="step.title" class="row" style="gap: 10px; align-items: flex-start">
          <div class="device-icon">{{ step.icon }}</div>
          <div class="flex-1">
            <div class="device-name">{{ step.title }}</div>
            <div class="text-12 muted" style="margin-top: 2px">{{ step.text }}</div>
          </div>
        </div>

        <div class="row" style="justify-content: flex-end">
          <button class="primary" @click="emit('close')">{{ t('guide.gotIt') }}</button>
        </div>
      </div>
    </section>
  </div>
</template>
