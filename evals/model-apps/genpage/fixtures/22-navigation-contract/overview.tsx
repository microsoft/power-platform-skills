import { Button, makeStyles, tokens } from '@fluentui/react-components';

declare const Xrm: { Navigation?: { navigateTo?(input: Record<string, unknown>): Promise<void> } };
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Milo' }, { name: 'Luna' }];
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
// A page key written in a comment is help text, not a target.
const help = 'Open a pet or the gallery.';
// Xrm.Navigation.navigateTo({pageType:"generative",pageId:"commented-out"});

function openGallery() {
  void Xrm.Navigation?.navigateTo?.({
    ...{ pageId: "ignored-override" },
    pageType: "generative",
    pageId: "44444444-4444-4444-8444-444444444444",
    data: { pageId: "nested-data" },
  });
}

function openPet() {
  // A Unicode line separator ends this comment.   void Xrm.Navigation?.navigateTo?.({"page\u0054ype":"generative","page\u{49}d":"33333333-3333-4333-8333-333333333333"});
}

const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}><p>{rows.length} pets. {help}</p><Button onClick={openPet}>Pet</Button><Button onClick={openGallery}>Gallery</Button></div>;
};
export default GeneratedComponent;
