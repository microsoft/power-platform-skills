import { makeStyles, tokens } from '@fluentui/react-components';
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Project notes' }, { name: 'Release checklist' }];
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}>{rows.map((row) => <p key={row.name}>{row.name}</p>)}</div>;
};
export default GeneratedComponent;
