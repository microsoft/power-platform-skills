var _a;
import * as React from 'react';
import { Badge } from '@fluentui/react-components';
import { lvt_ticket_lvt_priority, lvt_ticket_statecode } from './RuntimeTypes';
var colors = (_a = {},
    _a[lvt_ticket_lvt_priority.High] = 'danger',
    _a[lvt_ticket_lvt_priority.Medium] = 'warning',
    _a[lvt_ticket_lvt_priority.Low] = 'informative',
    _a);
var GeneratedComponent = function (props) {
    var open = lvt_ticket_statecode.Active;
    return (React.createElement("div", null, [lvt_ticket_lvt_priority.Low, lvt_ticket_lvt_priority.High].map(function (p) {
        var _a;
        return (React.createElement(Badge, { key: p, color: (_a = colors[p]) !== null && _a !== void 0 ? _a : 'informative' }, "".concat(p, ":").concat(open)));
    })));
};
export default GeneratedComponent;
