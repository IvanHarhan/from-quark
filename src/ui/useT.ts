import { useCallback } from 'react';
import { translate, type MessageKey } from '../i18n';
import { useApp } from './store';

export function useT() {
  const lang = useApp((s) => s.lang);
  return useCallback((key: MessageKey, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);
}
