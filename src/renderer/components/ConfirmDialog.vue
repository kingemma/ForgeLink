<script setup>
import { useI18n } from 'vue-i18n';

/**
 * 通用确认弹窗。
 *
 * 破坏性操作（例如清空全部设备）必须二次确认，避免误触丢失本机档案。
 * 文案全部由调用方传入，组件本身不绑定具体业务。
 */
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '' },
  cancelText: { type: String, default: '' },
  danger: { type: Boolean, default: false },
});
const emit = defineEmits(['confirm', 'cancel']);
const { t } = useI18n();
</script>

<template>
  <div
    v-if="open"
    class="confirm-mask"
    @click.self="emit('cancel')"
  >
    <section class="panel confirm-panel">
      <div class="panel-title">
        <span>{{ danger ? '⚠️' : '❔' }}</span>
        <span class="flex-1">{{ title }}</span>
        <button class="ghost icon" :title="cancelText || t('common.cancel')" @click="emit('cancel')">✕</button>
      </div>

      <div class="panel-body col" style="gap: 14px">
        <div class="text-12 muted" style="line-height: 1.6">{{ message }}</div>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button @click="emit('cancel')">{{ cancelText || t('common.cancel') }}</button>
          <button :class="danger ? 'danger' : 'primary'" @click="emit('confirm')">
            {{ confirmText || t('common.confirm') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
