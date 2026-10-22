# Star rating plan

## Summary

- **Control:** Contoso.Controls.StarRating
- **Description:** Shows a whole number as 0-5 stars
- **Template:** field-standard
- **Recipe:** none
- **Connectivity:** online

## Hosts

- Model-driven apps
- Power Pages

## Properties

| Name | Usage | Type | Required | Default |
| --- | --- | --- | --- | --- |
| value | bound | Whole.None | yes |  |
| max | input | Whole.None | no | 5 |

## Bindings

| # | Kind | Table | Form | Target | Web | Phone | Tablet | Parameters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | field | account | Account (main) | column new_rating | yes | yes | yes | value=column:new_rating<br>max=static:5 (Whole.None) |

## Deploy target

- **Solution:** ContosoCore
- **Publisher prefix:** use solution publisher
- **Environment:** https://contoso.crm.dynamics.com
- **Registration:** `pac pcf push --environment <environment>` after skill-level consent.

## Power Pages steps

- Form field: add the PCF control to the matching Power Pages basic/advanced form field.

## Findings

- No blocking or advisory findings.

## What will be verified

- The manifest properties match the intended parameters.
- Each intended binding is present for every requested client.
- Draft and published form XML agree after publication.
- Power Pages journeys are manually configured where automation is not available.
