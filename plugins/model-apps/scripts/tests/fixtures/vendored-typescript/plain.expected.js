import * as React from 'react';
import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
var useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalL, display: 'flex', gap: '8px' } });
var GeneratedComponent = function (props) {
    var styles = useStyles();
    var _a = React.useState(0), count = _a[0], setCount = _a[1];
    var label = count > 0 ? "Clicked ".concat(count, " time").concat(count === 1 ? '' : 's') : 'Not clicked yet';
    return (React.createElement("div", { className: styles.root },
        React.createElement(Text, { weight: "semibold" }, label),
        React.createElement(Button, { appearance: "primary", onClick: function () { return setCount(function (c) { return c + 1; }); } }, "Click")));
};
export default GeneratedComponent;
