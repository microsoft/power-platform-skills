// Declarative template identifiers used by the current Power Pages creation experience.
// This is a curated allowlist, not an environment-specific template catalog. The
// public Create Website API reference still lists legacy identifiers, so keep
// those valid for callers that use the API directly without presenting them as
// the declarative template choices.
// See: https://learn.microsoft.com/rest/api/power-platform/powerpages/websites/create-website

const DECLARATIVE_SITE_TEMPLATES = Object.freeze([
  Object.freeze({
    name: 'StarterLayout1',
    displayName: 'Starter Layout 1',
    description:
      'This versatile template provides a basic, multipage navigation framework and simple building blocks for you to customize any way you want. Just click on a section or image to customize it.',
    capabilities: Object.freeze([
      'Home page',
      'Subpages',
      'Contact us',
      'Search results',
    ]),
    previews: Object.freeze([
      Object.freeze({
        name: 'home',
        displayName: 'Home page',
        desktop: 'skills/create-site/assets/declarative-previews/StarterLayout1/desktop-home.png',
        mobile: 'skills/create-site/assets/declarative-previews/StarterLayout1/mobile-home.png',
      }),
      Object.freeze({
        name: 'subpage-1',
        displayName: 'Sub page 1',
        desktop: 'skills/create-site/assets/declarative-previews/StarterLayout1/desktop-services.png',
        mobile: 'skills/create-site/assets/declarative-previews/StarterLayout1/mobile-services.png',
      }),
      Object.freeze({
        name: 'subpage-2',
        displayName: 'Sub page 2',
        desktop: 'skills/create-site/assets/declarative-previews/StarterLayout1/desktop-contact.png',
        mobile: 'skills/create-site/assets/declarative-previews/StarterLayout1/mobile-contact.png',
      }),
    ]),
  }),
  Object.freeze({
    name: 'BlankPage',
    displayName: 'Blank page',
    description:
      'This 1-page blank template provides a simple starting point to create a completely custom site with no preset sections or components.',
    capabilities: Object.freeze([
      'Home page',
    ]),
    // Microsoft-hosted maker preview assets:
    // https://content.powerapps.com/resource/makerx/static/media/desktop-1.8491dec4.27.png
    // https://content.powerapps.com/resource/makerx/static/media/phone-1.073fda69.27.png
    previews: Object.freeze([
      Object.freeze({
        name: 'home',
        displayName: 'Home page',
        desktop: 'skills/create-site/assets/declarative-previews/BlankPage/desktop-home.png',
        mobile: 'skills/create-site/assets/declarative-previews/BlankPage/mobile-home.png',
      }),
    ]),
  }),
  Object.freeze({
    name: 'ProgramRegistration',
    displayName: 'Program Registration',
    description:
      'Enable parents to browse after-school activities, review availability, and register online.',
  }),
  Object.freeze({
    name: 'EventPortal',
    displayName: 'Event Portal',
    description:
      'Give customers a central place to discover events, review complete event information, and register for the experiences that interest them.',
    capabilities: Object.freeze([
      'Customizable event template',
      'List of events',
      'Event details with location, agenda, speakers, and sponsors',
      'Event registration page',
    ]),
    requirements: Object.freeze([
      'Customer Insights - Journeys license',
    ]),
    warning:
      'Some components may not behave fully in design studio and can require pro-developer customization.',
    previews: Object.freeze([
      Object.freeze({
        name: 'home',
        displayName: 'Home page',
        desktop: 'skills/create-site/assets/declarative-previews/EventRegistration/desktop.png',
        mobile: 'skills/create-site/assets/declarative-previews/EventRegistration/mobile.png',
      }),
      Object.freeze({
        name: 'registration',
        displayName: 'Registration page',
        desktop: 'skills/create-site/assets/declarative-previews/EventRegistration/desktop-registration.png',
        mobile: 'skills/create-site/assets/declarative-previews/EventRegistration/mobile-registration.png',
      }),
      Object.freeze({
        name: 'about',
        displayName: 'Event about page',
        desktop: 'skills/create-site/assets/declarative-previews/EventRegistration/desktop-about.png',
        mobile: 'skills/create-site/assets/declarative-previews/EventRegistration/mobile-about.png',
      }),
    ]),
  }),
  Object.freeze({
    name: 'BookMeetings',
    displayName: 'Schedule and Manage Meetings',
    description:
      'Enable location selection and appointment scheduling with customizable calendars and reminders.',
  }),
]);

const LEGACY_DOCUMENTED_TEMPLATE_NAMES = Object.freeze([
  'DefaultPortalTemplate',
  'PowerPortals_ProgramRegistration',
  'PowerPortals_BookMeeting',
]);

const CREATE_WEBSITE_TEMPLATE_NAMES = new Set([
  ...DECLARATIVE_SITE_TEMPLATES.map((template) => template.name),
  ...LEGACY_DOCUMENTED_TEMPLATE_NAMES,
]);

function normalizeDeclarativeModelVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('--modelVersion must be Enhanced or Standard');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'enhanced') return 'Enhanced';
  if (normalized === 'standard') return 'Standard';
  throw new Error('--modelVersion must be Enhanced or Standard');
}

module.exports = {
  DECLARATIVE_SITE_TEMPLATES,
  LEGACY_DOCUMENTED_TEMPLATE_NAMES,
  CREATE_WEBSITE_TEMPLATE_NAMES,
  normalizeDeclarativeModelVersion,
};
