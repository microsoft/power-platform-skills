'use strict';

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))];
}

function selectPreviewScreens(compiled, journey, navigation = null) {
  const screens = compiled?.screens || [];
  const byId = new Map(screens.map((screen) => [screen.screenId, screen]));
  const primary = journey?.journeys?.[0];
  const journeyIds = unique(
    [...(primary?.steps || [])]
      .sort((left, right) => left.order - right.order)
      .map((step) => step.surface?.screenId),
  );
  const candidateIds = journeyIds.length > 0
    ? journeyIds
    : screens.map((screen) => screen.screenId);

  const destinations = navigation?.visibleTabs?.length
    ? navigation.visibleTabs
    : navigation?.durableDestinations || [];
  const primaryId = destinations
    .map((destination) => destination.rootScreenId)
    .find((screenId) => byId.has(screenId))
    || screens.find((screen) => screen.classification === 'durable-destination')?.screenId
    || candidateIds[0];
  const flowEntryId = candidateIds.find((screenId) => screenId !== primaryId) || null;
  const decisionCandidates = candidateIds
    .filter((screenId) => screenId !== primaryId && screenId !== flowEntryId)
    .map((screenId, index) => ({ screen: byId.get(screenId), index }))
    .filter((entry) => entry.screen);
  const nonConfirmation = decisionCandidates.filter(
    ({ screen }) => screen.pattern !== 'confirmation',
  );
  const candidates = nonConfirmation.length ? nonConfirmation : decisionCandidates;
  const score = ({ screen, index }) => {
    const operations = screen.implementationContract?.requiredOperations || [];
    const writes = operations.filter(
      (operation) => ['create', 'update', 'delete', 'external-call'].includes(operation.kind),
    ).length;
    return (screen.pack.primaryActionPlacement === 'sticky-bottom' ? 8 : 0)
      + (['bounded-flow-step', 'modal-or-immersive-utility'].includes(screen.classification) ? 4 : 0)
      + (['form', 'capture', 'workflow-step', 'comparison'].includes(screen.pattern) ? 3 : 0)
      + writes * 2
      + index / 100;
  };
  const decisionId = [...candidates]
    .sort((left, right) => score(right) - score(left))[0]?.screen.screenId || null;

  return unique([primaryId, flowEntryId, decisionId])
    .slice(0, 3)
    .map((id) => byId.get(id))
    .filter(Boolean);
}

module.exports = { selectPreviewScreens };