// « Pilot Content »: the shop's posts on Facebook and Instagram. Calendrier (./Planner.tsx): posts and stories
// planned on a calendar, photos or a video at the highest quality, a caption the AI writes and fixes, a score out of 10,
// « Fill my week », posted by Pilotix at the chosen time (the 'cm-plan' job). Résultats (./Results.tsx): what each post
// did, Meta's numbers and the orders it brought. Réglages (./Settings.tsx, administrator): the fixed times, the yes
// before a marketer's post goes out, the first comment. Each post is linked to the product it sells, so Pilot Comments
// answers its comments with the right price.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../lib/session';
import { AgentHeader } from '../ai/agent';
import type { PageProps } from '../registry';
import { Planner } from './Planner';
import { Results } from './Results';
import { Settings } from './Settings';
import '../messages/messages.css';
import './results.css';

const TAB_ICON: Record<string, string> = { calendrier: 'calendar', resultats: 'chart', reglages: 'settings' };

export function Social({ sub }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  // on: a Facebook Page or an Instagram account is linked, so the planned posts can go out
  const [linked, setLinked] = useState<boolean>();
  const keys = ['calendrier', 'resultats', ...(admin ? ['reglages'] : [])];
  const current = keys.includes(sub ?? '') ? sub! : 'calendrier';
  const tabs = keys.map((k) => ({ key: k, label: t(`social.tabs.${k}`), icon: TAB_ICON[k], href: `#/social/${k}` }));
  return (
    <>
      <AgentHeader agent="social" title={t('social.title')} help={t('social.help')} about={t('ai.about.social')} on={linked} settings={admin ? '#/comptes' : undefined} tabs={tabs} current={current} />
      {current === 'calendrier' && <Planner onLinked={setLinked} />}
      {current === 'resultats' && <Results admin={admin} />}
      {current === 'reglages' && <Settings />}
    </>
  );
}
