'use strict';

// This is the complete vocabulary contract consumed by gen-mock-services.js.
// Keeping the bounds here prevents validation from approving a vocabulary that
// fails later when generation reaches a less-common semantic field.
const POOLS = {
  person: [8, 10],
  company: [6, 8],
  location: [4, 6],
  door: [6, 8],
  title: [6, 8],
  note: [5, 6],
  role: [1, 12],
  status: [3, 8],
  priority: [3, 5],
  category: [4, 10],
  seat: [6, 12],
  flight: [4, 8],
  url: [3, 6],
};

module.exports = { POOLS };