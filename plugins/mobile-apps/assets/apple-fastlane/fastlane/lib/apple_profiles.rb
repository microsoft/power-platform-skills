# frozen_string_literal: true

require "fileutils"
require "digest"
require "json"
require "time"

module MobileAppAppleProfiles
  VERSION = "1.0.0"
  TEAM_ID = /\A[A-Z0-9]{10}\z/
  BUNDLE_ID = /\A[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+\z/
  UUID = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i
  RESOURCE_ID = /\A[A-Za-z0-9][A-Za-z0-9._:-]{2,127}\z/
  SERVICE_ID = /\A[A-Za-z0-9][A-Za-z0-9._:-]{2,127}\z/
  SHA256 = /\Asha256:[0-9a-f]{64}\z/
  PROOF_SECONDS = 60 * 60
  TYPES = %w[development ad-hoc].freeze

  EXPECTED = {
    "development" => {
      certificate_type: "apple-development",
      aps_environment: "development",
      get_task_allow: true
    },
    "ad-hoc" => {
      certificate_type: "apple-distribution",
      aps_environment: "production",
      get_task_allow: false
    }
  }.freeze

  class Blocked < StandardError
    attr_reader :code, :details

    def initialize(code, details = {})
      @code = code
      @details = details
      super(code)
    end
  end

  class ProfileUnavailable < StandardError; end
  class InstallFailed < StandardError; end

  module_function

  def confirmation_token(team_id, bundle_id, device_count, scope)
    normalized_scope = TYPES.select { |type| scope.include?(type) }.join("+")
    "refresh-provisioning-profiles-#{team_id}-#{bundle_id}-#{device_count}-#{normalized_scope}"
  end

  # The decoder supplies a plist Hash and a certificate resolver. Keeping the
  # parser independent of CMS/OpenSSL lets tests use inert strings rather than
  # committing real provisioning profiles or certificate material.
  def metadata_from_plist(plist, certificate_resolver:)
    raise Blocked, "profile-metadata-malformed" unless plist.is_a?(Hash)

    entitlements = plist["Entitlements"]
    team_ids = plist["TeamIdentifier"]
    devices = plist["ProvisionedDevices"]
    certificates = plist["DeveloperCertificates"]
    raise Blocked, "profile-metadata-malformed" unless entitlements.is_a?(Hash)
    raise Blocked, "profile-metadata-malformed" unless team_ids.is_a?(Array) && team_ids.length == 1
    raise Blocked, "profile-metadata-malformed" unless devices.is_a?(Array) && !devices.empty?
    raise Blocked, "profile-metadata-malformed" unless certificates.is_a?(Array) && !certificates.empty?

    resolved = certificates.map { |certificate| certificate_resolver.call(certificate) }.compact
    raise Blocked, "profile-certificate-unrecognized" unless resolved.length == 1

    application_identifier = entitlements["application-identifier"].to_s
    team_id = team_ids.first.to_s
    prefix = "#{team_id}."
    raise Blocked, "profile-application-identifier-mismatch" unless application_identifier.start_with?(prefix)

    {
      uuid: plist["UUID"].to_s,
      name: plist["Name"].to_s,
      team_id: team_id,
      bundle_id: application_identifier.delete_prefix(prefix),
      application_identifier: application_identifier,
      entitlement_team_id: entitlements["com.apple.developer.team-identifier"].to_s,
      expires_at: time_value(plist["ExpirationDate"]),
      provisioned_device_count: devices.length,
      provisioned_device_digest: device_digest(devices),
      get_task_allow: entitlements["get-task-allow"],
      aps_environment: entitlements["aps-environment"].to_s,
      provisions_all_devices: plist["ProvisionsAllDevices"] == true,
      beta_reports_active: entitlements["beta-reports-active"] == true,
      certificate_resource_id: resolved.first.fetch(:resource_id).to_s,
      certificate_type: resolved.first.fetch(:type).to_s
    }
  rescue KeyError
    raise Blocked, "profile-certificate-unrecognized"
  end

  def verify_metadata!(metadata, type:, team_id:, bundle_id:, certificate:, device_count:, device_digest:, now:)
    expected = EXPECTED.fetch(type)
    raise Blocked, "profile-uuid-invalid" unless UUID.match?(metadata[:uuid].to_s)
    raise Blocked, "profile-team-mismatch" unless metadata[:team_id] == team_id
    raise Blocked, "profile-entitlement-team-mismatch" unless metadata[:entitlement_team_id] == team_id
    raise Blocked, "profile-bundle-mismatch" unless metadata[:bundle_id] == bundle_id
    raise Blocked, "profile-expired" unless metadata[:expires_at].is_a?(Time) && metadata[:expires_at] > now + PROOF_SECONDS
    raise Blocked, "profile-device-coverage-stale" unless metadata[:provisioned_device_count] == device_count
    raise Blocked, "profile-device-coverage-stale" unless metadata[:provisioned_device_digest] == device_digest
    raise Blocked, "profile-mode-mismatch" unless metadata[:get_task_allow] == expected[:get_task_allow]
    raise Blocked, "profile-apns-environment-mismatch" unless metadata[:aps_environment] == expected[:aps_environment]
    raise Blocked, "profile-distribution-mode-mismatch" if metadata[:provisions_all_devices] || metadata[:beta_reports_active]
    raise Blocked, "profile-certificate-resource-mismatch" unless metadata[:certificate_resource_id] == certificate.fetch("resourceId")
    raise Blocked, "profile-certificate-type-mismatch" unless metadata[:certificate_type] == expected[:certificate_type]
    raise Blocked, "profile-certificate-type-mismatch" unless certificate.fetch("type") == expected[:certificate_type]
  end

  def run(team_id:, bundle_id:, confirm:, refresh:, devices_changed:, keychain:,
          identifier_path:, certificates_path:, output_path:, adapter:, now: Time.now.utc)
    raise Blocked, "invalid-team-id" unless TEAM_ID.match?(team_id.to_s)
    raise Blocked, "invalid-bundle-id" unless BUNDLE_ID.match?(bundle_id.to_s)
    validate_output_path!(output_path, refresh: refresh.to_s == "true")
    validate_keychain!(keychain)
    identifier = read_json(identifier_path, "identifier-proof")
    certificates = read_json(certificates_path, "certificate-proof")
    validate_identifier!(identifier, team_id, bundle_id, now)
    certificate_map = validate_certificates!(certificates, team_id, now)

    state = adapter.inspect_state(team_id: team_id, bundle_id: bundle_id)
    validate_access!(state)
    device_count = state[:enabled_device_count]
    raise Blocked, "registered-enabled-devices-required" unless device_count.is_a?(Integer) && device_count.positive?
    enabled_device_digest = state[:enabled_device_digest]
    raise Blocked, "registered-device-proof-invalid" unless SHA256.match?(enabled_device_digest.to_s)

    obtained = {}
    refresh_scope = devices_changed.to_s == "true" ? TYPES.dup : []
    refresh_reasons = devices_changed.to_s == "true" ? TYPES.to_h { |type| [type, "new-devices"] } : {}
    TYPES.each do |type|
      begin
        profile = adapter.obtain_profile(
          team_id: team_id,
          bundle_id: bundle_id,
          type: type,
          certificate: certificate_map.fetch(type),
          force: false
        )
        verify_metadata!(
          profile.fetch(:metadata),
          type: type,
          team_id: team_id,
          bundle_id: bundle_id,
          certificate: certificate_map.fetch(type),
          device_count: device_count,
          device_digest: enabled_device_digest,
          now: now
        )
        obtained[type] = profile
      rescue ProfileUnavailable
        refresh_scope << type unless refresh_scope.include?(type)
        refresh_reasons[type] = "missing-or-unavailable"
      rescue Blocked => error
        refresh_scope << type unless refresh_scope.include?(type)
        refresh_reasons[type] = error.code
      end
    end

    unless refresh_scope.empty?
      expected = confirmation_token(team_id, bundle_id, device_count, refresh_scope)
      unless confirm.to_s == expected
        raise Blocked.new(
          "profile-refresh-confirmation-required",
          confirmation_token: expected,
          device_count: device_count,
          scope: TYPES.select { |type| refresh_scope.include?(type) },
          reasons: refresh_reasons
        )
      end

      refresh_scope.each do |type|
        obtained[type] = adapter.obtain_profile(
          team_id: team_id,
          bundle_id: bundle_id,
          type: type,
          certificate: certificate_map.fetch(type),
          force: true
        )
      rescue ProfileUnavailable
        raise Blocked, "profile-create-or-refresh-failed"
      end
    end

    verified = {}
    TYPES.each do |type|
      profile = obtained.fetch(type)
      verify_metadata!(
        profile.fetch(:metadata),
        type: type,
        team_id: team_id,
        bundle_id: bundle_id,
        certificate: certificate_map.fetch(type),
        device_count: device_count,
        device_digest: enabled_device_digest,
        now: now
      )
      installed_metadata = adapter.install_profile(profile)
      verify_metadata!(
        installed_metadata,
        type: type,
        team_id: team_id,
        bundle_id: bundle_id,
        certificate: certificate_map.fetch(type),
        device_count: device_count,
        device_digest: enabled_device_digest,
        now: now
      )
      verified[type] = installed_metadata
    rescue InstallFailed
      raise Blocked, "profile-install-failed"
    end

    result = build_contract(
      team_id: team_id,
      bundle_id: bundle_id,
      identifier: identifier,
      keychain: keychain,
      certificates: certificate_map,
      profiles: verified,
      device_count: device_count,
      now: now
    )
    write_handoff(output_path, result, refresh: refresh.to_s == "true")
    result
  ensure
    adapter.cleanup! if adapter.respond_to?(:cleanup!)
  end

  def build_contract(team_id:, bundle_id:, identifier:, keychain:, certificates:, profiles:, device_count:, now:)
    profile_entry = lambda do |type|
      metadata = profiles.fetch(type)
      expected = EXPECTED.fetch(type)
      {
        "uuid" => metadata.fetch(:uuid),
        "type" => type,
        "expiresAt" => metadata.fetch(:expires_at).utc.iso8601(3),
        "bundleId" => bundle_id,
        "teamId" => team_id,
        "apnsEnvironment" => expected[:aps_environment],
        "getTaskAllow" => expected[:get_task_allow],
        "deviceCount" => device_count,
        "certificateResourceId" => metadata.fetch(:certificate_resource_id),
        "certificateType" => metadata.fetch(:certificate_type),
        "proof" => "installed-profile-metadata-readback"
      }
    end
    certificate_entry = lambda do |type|
      certificate = certificates.fetch(type)
      {
        "resourceId" => certificate.fetch("resourceId"),
        "type" => certificate.fetch("type"),
        "expiresAt" => certificate.fetch("expiresAt"),
        "proof" => "keychain-identity-readback"
      }
    end
    verified_at = now.utc
    {
      "version" => 1,
      "modes" => TYPES,
      "teamId" => team_id,
      "bundleId" => bundle_id,
      "pushCapability" => {
        "capability" => "aps-environment",
        "enabled" => true,
        "proof" => identifier.dig("pushCapability", "proof")
      },
      "keychain" => keychain,
      "certificates" => {
        "development" => certificate_entry.call("development"),
        "distribution" => certificate_entry.call("ad-hoc")
      },
      "profiles" => {
        "development" => profile_entry.call("development"),
        "adHoc" => profile_entry.call("ad-hoc")
      },
      "proof" => {
        "verifier" => "apple-ios-provisioning-preflight",
        "verifierVersion" => VERSION,
        "verifiedAt" => verified_at.iso8601(3),
        "validUntil" => (verified_at + PROOF_SECONDS).iso8601(3),
        "steps" => {
          "teamAndBundleVerified" => true,
          "pushCapabilityVerified" => true,
          "keychainVerified" => true,
          "developmentCertificateVerified" => true,
          "distributionCertificateVerified" => true,
          "developmentProfileVerified" => true,
          "adHocProfileVerified" => true
        }
      }
    }
  end

  def validate_keychain!(keychain)
    raise Blocked, "keychain-proof-missing" unless keychain.is_a?(Hash)
    raise Blocked, "keychain-proof-invalid" unless SERVICE_ID.match?(keychain["serviceIdentifier"].to_s)
    raise Blocked, "keychain-proof-invalid" unless SHA256.match?(keychain["pathFingerprint"].to_s)
  end

  def validate_identifier!(identifier, team_id, bundle_id, now)
    raise Blocked, "identifier-proof-invalid" unless identifier["status"] == "ready"
    raise Blocked, "identifier-team-mismatch" unless identifier["teamId"] == team_id
    raise Blocked, "identifier-bundle-mismatch" unless identifier["bundleId"] == bundle_id
    raise Blocked, "identifier-proof-invalid" unless identifier.dig("identifier", "type") == "explicit"
    raise Blocked, "identifier-proof-invalid" unless identifier.dig("identifier", "platform") == "ios"
    raise Blocked, "push-capability-invalid" unless identifier.dig("pushCapability", "enabled") == true
    validate_proof_window!(identifier["proof"], now, "identifier-proof")
  end

  def validate_certificates!(document, team_id, now)
    raise Blocked, "certificate-proof-invalid" unless document["status"] == "ready"
    raise Blocked, "certificate-team-mismatch" unless document["teamId"] == team_id
    validate_proof_window!(document["proof"], now, "certificate-proof")
    by_type = Array(document["certificates"]).to_h { |certificate| [certificate["type"], certificate] }
    {
      "development" => validate_certificate!(by_type["apple-development"], "apple-development", now),
      "ad-hoc" => validate_certificate!(by_type["apple-distribution"], "apple-distribution", now)
    }
  end

  def validate_certificate!(certificate, type, now)
    raise Blocked, "certificate-proof-invalid" unless certificate.is_a?(Hash)
    raise Blocked, "certificate-type-mismatch" unless certificate["type"] == type
    raise Blocked, "certificate-resource-invalid" unless RESOURCE_ID.match?(certificate["resourceId"].to_s)
    raise Blocked, "certificate-keychain-proof-invalid" unless certificate["proof"] == "dedicated-keychain-code-signing-identity"
    expires_at = time_value(certificate["expiresAt"])
    raise Blocked, "certificate-expired" unless expires_at > now + PROOF_SECONDS
    certificate.merge("expiresAt" => expires_at.iso8601(3))
  end

  def validate_proof_window!(proof, now, code)
    raise Blocked, code unless proof.is_a?(Hash)
    verified_at = time_value(proof["verifiedAt"])
    valid_until = time_value(proof["validUntil"])
    raise Blocked, code unless verified_at <= now + 300 && valid_until > now
  rescue ArgumentError
    raise Blocked, code
  end

  def validate_access!(state)
    raise Blocked, "team-membership" unless state[:team_found] == true
    raise Blocked, "agreements" if state[:pending_agreements] == true
    raise Blocked, "cip-permissions" unless state[:profiles_readable] == true
  end

  def read_json(path, code)
    raise Blocked, "#{code}-missing" unless File.file?(path) && !File.symlink?(path)
    JSON.parse(File.read(path))
  rescue JSON::ParserError
    raise Blocked, "#{code}-malformed"
  end

  def time_value(value)
    return value.utc if value.is_a?(Time)

    Time.iso8601(value.to_s).utc
  rescue ArgumentError
    raise Blocked, "profile-timestamp-invalid"
  end

  def device_digest(devices)
    normalized = devices.map { |value| value.to_s.delete("-").upcase }.sort
    "sha256:#{Digest::SHA256.hexdigest(normalized.join("\n"))}"
  end

  def write_handoff(output_path, result, refresh:)
    if File.exist?(output_path) || File.symlink?(output_path)
      raise Blocked, "unsafe-handoff-path" if File.symlink?(output_path) || !File.file?(output_path)
      existing = JSON.parse(File.read(output_path)) rescue nil
      return if existing == result
      raise Blocked, "refresh-approval-required" unless refresh
    end

    flags = File::WRONLY | File::CREAT
    flags |= refresh ? File::TRUNC : File::EXCL
    File.open(output_path, flags, 0o600) do |descriptor|
      descriptor.write(JSON.pretty_generate(result))
      descriptor.write("\n")
      descriptor.flush
      descriptor.fsync
    end
  end

  def validate_output_path!(output_path, refresh:)
    return unless File.exist?(output_path) || File.symlink?(output_path)

    raise Blocked, "unsafe-handoff-path" if File.symlink?(output_path) || !File.file?(output_path)
    raise Blocked, "refresh-approval-required" unless refresh
  end
end
