# frozen_string_literal: true

require "json"
require "time"

module MobileAppApplePreflight
  VERSION = "1.0.0"
  TEAM_ID = /\A[A-Z0-9]{10}\z/
  BUNDLE_ID = /\A[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+\z/
  PROOF_SECONDS = 60 * 60

  class Blocked < StandardError
    attr_reader :code

    def initialize(code)
      @code = code
      super(code)
    end
  end

  module_function

  def pending_agreements?(value)
    return false if value.nil? || value == false
    return !value.empty? if value.is_a?(Array)
    if value.is_a?(Hash)
      agreement_values = value.filter_map do |key, child|
        child if key.to_s.match?(/agreement|pending|contract/i)
      end
      return agreement_values.any? do |child|
        child == true ||
          (child.respond_to?(:empty?) && !child.empty?) ||
          (child.is_a?(String) && child.match?(/\Apending\z/i))
      end
    end
    return value.match?(/\Apending\z/i) if value.is_a?(String)

    value == true
  end

  def run(team_id:, bundle_id:, refresh:, adapter:, output_path:, now: Time.now.utc)
    raise Blocked, "invalid-team-id" unless TEAM_ID.match?(team_id.to_s)
    raise Blocked, "invalid-bundle-id" unless BUNDLE_ID.match?(bundle_id.to_s)

    observation = adapter.probe(team_id: team_id, bundle_id: bundle_id)
    raise Blocked, "team-membership" unless observation[:team_found] == true
    raise Blocked, "agreements" if observation[:pending_agreements] == true

    permissions = {
      "certificates" => observation[:certificates_readable] == true,
      "identifiers" => observation[:identifiers_readable] == true,
      "profiles" => observation[:profiles_readable] == true
    }
    raise Blocked, "cip-permissions" unless permissions.values.all?

    verified_at = now.utc
    result = {
      "version" => 1,
      "status" => "ready",
      "teamId" => team_id,
      "bundleId" => bundle_id,
      "authentication" => {
        "method" => "interactive-apple-id",
        "teamMembership" => "verified"
      },
      "permissions" => permissions,
      "agreements" => { "status" => "clear" },
      "identifier" => {
        "status" => observation[:identifier_present] == true ? "present" : "missing"
      },
      "proof" => {
        "verifier" => "apple-fastlane-preflight",
        "verifierVersion" => VERSION,
        "verifiedAt" => verified_at.iso8601(3),
        "validUntil" => (verified_at + PROOF_SECONDS).iso8601(3)
      }
    }

    write_handoff(output_path, result, refresh: refresh.to_s == "true")
    result
  end

  def write_handoff(output_path, result, refresh:)
    if File.exist?(output_path) || File.symlink?(output_path)
      raise Blocked, "unsafe-handoff-path" if File.symlink?(output_path) || !File.file?(output_path)
      raise Blocked, "refresh-approval-required" unless refresh
    end

    flags = File::WRONLY | File::CREAT
    flags |= refresh ? File::TRUNC : File::EXCL
    descriptor = File.open(output_path, flags, 0o600)
    begin
      descriptor.write(JSON.pretty_generate(result))
      descriptor.write("\n")
      descriptor.flush
      descriptor.fsync
    ensure
      descriptor.close
    end
  end
end
