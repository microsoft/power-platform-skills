'use strict';

async function withNoAdoAcquire(fn) {
  const savedToken = process.env.ADO_TOKEN;
  const savedNoAcquire = process.env.POWERPAGES_NO_ADO_ACQUIRE;
  delete process.env.ADO_TOKEN;
  process.env.POWERPAGES_NO_ADO_ACQUIRE = '1';
  try {
    return await fn();
  } finally {
    if (savedToken !== undefined) process.env.ADO_TOKEN = savedToken;
    else delete process.env.ADO_TOKEN;
    if (savedNoAcquire !== undefined) process.env.POWERPAGES_NO_ADO_ACQUIRE = savedNoAcquire;
    else delete process.env.POWERPAGES_NO_ADO_ACQUIRE;
  }
}

module.exports = { withNoAdoAcquire };