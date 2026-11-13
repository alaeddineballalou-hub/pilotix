// Control room › Pilot AI › Les 3 IA: Claude, ChatGPT (OpenAI) and Gemini in one place. For each one: does Pilotix have
// its key (paste a new one, or remove it), what it does in Pilotix, what it cost today, this month and the last 30 days
// (a small bar a day), what shops paid with their own keys apart, and the company's own billing page.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import type { POut } from '../../lib/platform';
import { usePilotAction, usePilotRpc } from './pilotDemo';

type Data = POut<'p.ai.providers'>;
type Prov = 'claude' | 'openai' | 'gemini';
const PROVS: { k: Prov; name: string; billing: string; placeholder: string }[] = [
  { k: 'claude', name: 'Claude (Anthropic)', billing: 'https://console.anthropic.com/settings/billing', placeholder: 'sk-ant-…' },
  { k: 'openai', name: 'ChatGPT (OpenAI)', billing: 'https://platform.openai.com/usage', placeholder: 'sk-…' },
  { k: 'gemini', name: 'Gemini (Google)', billing: 'https://aistudio.google.com/usage', placeholder: 'AIza… / AQ.…' },
];
const usd = (x: number) => (x > 0 && x < 0.01 ? '< 0.01 $' : `${x.toFixed(2)} $`);

export function AiKeysCard({ manager, claude }: { manager: boolean; claude: { enabled: boolean; maxUsd: number; share: number; dayUsd: number } }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.ai.providers', {});
  const voice = usePilotRpc('p.pilot.voice', {});
  const k = 'platform.pilot.ai.';
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const total = (f: 'today' | 'month' | 'days30') => PROVS.reduce((a, p) => a + d.providers[p.k][f], 0);
  const da = (x: number) => (d.rate ? ` · ${Math.round(x * d.rate).toLocaleString('fr-DZ')} DA` : '');
  return (
    <Card title={t(k + 'title')}>
      <p className="small muted">{t(k + 'text')}</p>
      <div className="ai3-total">
        <span>
          {t(k + 'today')} <b className="ltr">{usd(total('today'))}</b>
        </span>
        <span>
          {t(k + 'month')} <b className="ltr">{usd(total('month'))}</b>
          <span className="muted small">{da(total('month'))}</span>
        </span>
        <span>
          {t(k + 'days30')} <b className="ltr">{usd(total('days30'))}</b>
        </span>
      </div>
      <div className="ai3">
        {PROVS.map((p) => (
          <ProvCard
            key={p.k}
            p={p}
            d={d}
            manager={manager}
            claude={claude}
            voice={voice.data ? { enabled: voice.data.enabled, model: voice.data.model } : null}
            onSaved={() => void q.refetch()}
          />
        ))}
      </div>
      <p className="small muted">{t(k + 'note')}</p>
    </Card>
  );
}

function ProvCard({
  p,
  d,
  manager,
  claude,
  voice,
  onSaved,
}: {
  p: (typeof PROVS)[number];
  d: Data;
  manager: boolean;
  claude: { enabled: boolean; maxUsd: number; share: number; dayUsd: number };
  voice: { enabled: boolean; model: string } | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const k = 'platform.pilot.ai.';
  const s = d.providers[p.k];
  const has = d.keys[p.k].hasKey;
  const [key, setKey] = useState('');
  const done = { success: t('platform.saved'), onDone: () => (setKey(''), onSaved()) };
  const saveClaude = usePilotAction('p.pilot.save', done);
  const saveGemini = usePilotAction('p.pilot.voiceSave', done);
  const saveOpenai = usePilotAction('p.ai.openaiKey', done);
  const busy = saveClaude.isPending || saveGemini.isPending || saveOpenai.isPending;
  const send = (v: string | null) => {
    if (p.k === 'claude') saveClaude.mutate({ ...claude, key: v });
    else if (p.k === 'gemini') saveGemini.mutate({ enabled: voice?.enabled ?? false, model: voice?.model || 'gemini-flash-latest', key: v });
    else saveOpenai.mutate({ key: v });
  };
  // the last 30 days, oldest first, as small bars
  const days: { day: string; usd: number }[] = [];
  const end = Date.parse(`${d.today}T00:00:00Z`);
  for (let i = d.days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ day, usd: s.byDay[day] ?? 0 });
  }
  const top = Math.max(0.0001, ...days.map((x) => x.usd));
  return (
    <div className={`ai3-card ai3-${p.k}`}>
      <div className="ai3-head">
        <b>{p.name}</b>
        <span className={`chip ${has ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{has ? t(k + 'linked') : t(k + 'missing')}</span>
      </div>
      <p className="small muted">{t(k + `use.${p.k}`)}</p>
      <div className="ai3-nums">
        <span>
          <span className="muted small">{t(k + 'today')}</span>
          <b className="ltr">{usd(s.today)}</b>
        </span>
        <span>
          <span className="muted small">{t(k + 'month')}</span>
          <b className="ltr">{usd(s.month)}</b>
        </span>
        <span>
          <span className="muted small">{t(k + 'days30')}</span>
          <b className="ltr">{usd(s.days30)}</b>
        </span>
      </div>
      <div className="ai3-bars ltr" role="img" aria-label={t(k + 'bars', { usd: usd(s.days30) })}>
        {days.map((x) => (
          <i key={x.day} title={`${x.day} · ${usd(x.usd)}`} style={{ height: `${Math.max(x.usd > 0 ? 8 : 2, (x.usd / top) * 100)}%` }} />
        ))}
      </div>
      <p className="small muted">
        {t(k + 'calls', { count: s.calls30, n: s.calls30.toLocaleString('fr-DZ') })}
        {s.shopsOwn30 > 0 && <> · {t(k + 'shopsOwn', { usd: usd(s.shopsOwn30) })}</>}
      </p>
      {manager && (
        <>
          <Field label={t(k + 'key')} hint={has ? t(k + 'keyKept') : t(k + `keyHint.${p.k}`)}>
            <input type="password" className="ltr" autoComplete="off" value={key} placeholder={has ? '••••••••' : p.placeholder} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary small" disabled={busy || !key.trim()} onClick={() => send(key.trim())}>
              <Icon name="check" /> {has ? t(k + 'change') : t(k + 'link')}
            </button>
            {has && (
              <button type="button" className="btn small" disabled={busy} onClick={() => window.confirm(t(k + 'removeAsk', { name: p.name })) && send(null)}>
                {t('platform.pilot.keyRemove')}
              </button>
            )}
            <a className="btn ghost small" href={p.billing} target="_blank" rel="noreferrer">
              <Icon name="link" /> {t(k + 'billing')}
            </a>
          </div>
        </>
      )}
    </div>
  );
}
