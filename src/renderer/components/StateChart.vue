<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 极简 SVG 趋势图。
 * 监测数据的意义在于「变化形状」，因此只需要折线 + 极值标注，不引入图表库。
 */
const props = defineProps({
  points: { type: Array, default: () => [] },
  height: { type: Number, default: 72 },
  width: { type: Number, default: 380 },
  color: { type: String, default: '#38bdf8' },
});
const { t } = useI18n();

const stats = computed(() => {
  const values = props.points.filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = props.width / (values.length - 1);
  const path = values
    .map((value, index) => {
      const x = index * stepX;
      const y = props.height - 6 - ((value - min) / span) * (props.height - 14);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const area = `${path} L${props.width},${props.height} L0,${props.height} Z`;
  return { min, max, path, area, last: values[values.length - 1] };
});
</script>

<template>
  <div>
    <svg v-if="stats" :viewBox="`0 0 ${width} ${height}`" :height="height" preserveAspectRatio="none" style="width: 100%">
      <path :d="stats.area" :fill="color" opacity="0.12" />
      <path :d="stats.path" fill="none" :stroke="color" stroke-width="1.8" stroke-linejoin="round" />
    </svg>
    <div v-else class="text-11 muted" :style="{ height: height + 'px' }" style="display: grid; place-items: center">
      {{ t('chart.noData') }}
    </div>
    <div v-if="stats" class="row text-11 muted" style="justify-content: space-between">
      <span>min {{ stats.min }}</span>
      <span class="mono" :style="{ color }">{{ t('chart.current') }} {{ stats.last }}</span>
      <span>max {{ stats.max }}</span>
    </div>
  </div>
</template>
