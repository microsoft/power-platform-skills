'use strict';

const { canonicalJson, sha256Hex } = require('./product-experience-contracts');

function navigationDestination(destination) {
  return {
    destinationId: destination.destinationId,
    label: destination.label,
    rootScreenId: destination.rootScreenId,
    targetPath: destination.targetPath,
  };
}

function navigationContract(navigation) {
  return {
    manifestRevision: navigation.manifestRevision,
    pattern: navigation.pattern,
    visibleDestinations: (navigation.visibleTabs || []).map(navigationDestination),
    durableDestinations: (navigation.durableDestinations || []).map(navigationDestination),
    returnHomeMechanism: navigation.returnHomeMechanism,
  };
}

function buildSharedDesignInputs({
  experienceDirective,
  navigation,
  tokenContract,
  signatureComponentsSource,
}) {
  if (!experienceDirective || typeof experienceDirective !== 'object') {
    throw new Error('shared design inputs require experienceDirective');
  }
  if (!navigation || typeof navigation !== 'object' || !navigation.manifestRevision) {
    throw new Error('shared design inputs require a revisioned navigation manifest');
  }
  if (!tokenContract?.ok || !tokenContract.revision) {
    throw new Error('shared design inputs require generated design tokens');
  }
  if (typeof signatureComponentsSource !== 'string' || !signatureComponentsSource.trim()) {
    throw new Error('shared design inputs require signature-component contracts');
  }
  const contract = {
    schemaVersion: 1,
    contractType: 'shared-product-design-inputs',
    experienceDirective: structuredClone(experienceDirective),
    tokens: {
      revision: tokenContract.revision,
      colors: structuredClone(tokenContract.colors),
      typography: structuredClone(tokenContract.typography),
    },
    navigation: navigationContract(navigation),
    signatureComponents: {
      revision: sha256Hex(signatureComponentsSource),
      source: signatureComponentsSource,
    },
  };
  contract.designInputRevision = sha256Hex(canonicalJson(contract));
  return contract;
}

module.exports = {
  buildSharedDesignInputs,
  navigationContract,
};