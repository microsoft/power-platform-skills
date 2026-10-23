import * as React from 'react';
import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { GeneratedComponentProps } from './RuntimeTypes';

const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalL, display: 'flex', gap: '8px' } });

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const styles = useStyles();
  const [count, setCount] = React.useState<number>(0);
  const label = count > 0 ? `Clicked ${count} time${count === 1 ? '' : 's'}` : 'Not clicked yet';
  return (
    <div className={styles.root}>
      <Text weight="semibold">{label}</Text>
      <Button appearance="primary" onClick={() => setCount((c) => c + 1)}>Click</Button>
    </div>
  );
};

export default GeneratedComponent;