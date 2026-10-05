import { makeStyles, tokens } from '@fluentui/react-components';
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Milo' }, { name: 'Luna' }];
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const help = 'PAGEREF_pet stays unchanged because it is display data.';
const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}><p>{help}</p>{rows.map((row) => <p key={row.name}>{row.name}</p>)}</div>;
};
export default GeneratedComponent;
