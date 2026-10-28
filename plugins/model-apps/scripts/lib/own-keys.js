'use strict';
// Reading a map keyed by NAMES — a dashboard's, a persona's, a status reason's label, a page's key — that a maker writes freely or a service
// returns. Any of those can be exactly a member of Object.prototype (`__proto__`, `constructor`, `toString`, `hasOwnProperty`, …), and each is a
// legal name. A plain object `{}` answers every one of them whether or not it was ever stored: `map.constructor` is the Object function,
// `map.toString` a function, `map.__proto__` the prototype itself — all truthy, so a "was it built?" lookup answers yes and hands the member on
// as the id. Writing `map.__proto__ = value` calls the inherited setter instead of storing an entry: JSON.stringify then leaves it out, and an
// object value becomes the map's prototype.
//
// The rule the plugin follows:
//   - a map it BUILDS from such names is a null-prototype object (`Object.create(null)`): every name is an own key, `__proto__` included, and a
//     name it does not hold reads as undefined. JSON.stringify writes its own keys in the same order whatever the prototype, so the bytes of a
//     result or record of ordinary names do not change;
//   - a map it READS by such a name, which can come from elsewhere — parsed JSON, a caller, a `|| {}` fallback — is read with `ownValue`, which
//     answers an entry only when the map holds it as its own.
// JSON.parse makes every key of its text an own data property, `__proto__` included (it never calls the setter), so an own read of parsed JSON
// finds what the text holds.
// See: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Object#null-prototype_objects

// The value `map` holds under `key` as its OWN property, or undefined: for a key it does not hold, for an inherited member, and for anything
// that is not an object (undefined, null, a string).
function ownValue(map, key) {
  return map !== null && typeof map === 'object' && Object.hasOwn(map, key) ? map[key] : undefined;
}

module.exports = { ownValue };
