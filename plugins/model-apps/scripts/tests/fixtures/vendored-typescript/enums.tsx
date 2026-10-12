import * as React from 'react';
import { Badge } from '@fluentui/react-components';
import { lvt_ticket_lvt_priority, lvt_ticket_statecode } from './RuntimeTypes';
import type { GeneratedComponentProps } from './RuntimeTypes';

const colors: Record<number, 'danger' | 'warning' | 'informative'> = {
  [lvt_ticket_lvt_priority.High]: 'danger',
  [lvt_ticket_lvt_priority.Medium]: 'warning',
  [lvt_ticket_lvt_priority.Low]: 'informative',
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const open = lvt_ticket_statecode.Active;
  return (
    <div>
      {[lvt_ticket_lvt_priority.Low, lvt_ticket_lvt_priority.High].map((p) => (
        <Badge key={p} color={colors[p] ?? 'informative'}>{`${p}:${open}`}</Badge>
      ))}
    </div>
  );
};

export default GeneratedComponent;