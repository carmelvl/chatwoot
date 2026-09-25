# Kita: the desk's side of kita-bridges (the Slack / Teams / Viber / WhatsApp bridge).
# Connect links are signed exactly like kita-bridges/src/links.ts (signConnectLink):
#   <BRIDGE_PUBLIC_URL>/connect?a=<user id>&e=<email>&x=<expiry>&s=HEX(HMAC_SHA256(secret, "id|email|expiry"))
module Kita::Bridge
  LINK_TTL = 7.days
  EXTERNAL_SOURCES = %w[slack teams whatsapp viber].freeze
  STATUS_TIMEOUT = 5

  module_function

  def secret
    ENV.fetch('BRIDGE_LINK_SECRET')
  end

  def public_url
    ENV.fetch('BRIDGE_PUBLIC_URL', 'https://support.internal.kita.ai/bridges').chomp('/')
  end

  # Server-to-server base URL (inside docker compose the bridge is `bridges:8080`).
  def internal_url
    ENV.fetch('BRIDGE_INTERNAL_URL', 'http://bridges:8080').chomp('/')
  end

  def connect_url(user, now: Time.current)
    "#{public_url}/connect?#{URI.encode_www_form(signed_params(user, now: now))}"
  end

  def signed_params(user, now: Time.current)
    email = user.email.downcase
    exp = now.to_i + LINK_TTL.to_i
    { a: user.id.to_s, e: email, x: exp.to_s, s: OpenSSL::HMAC.hexdigest('SHA256', secret, "#{user.id}|#{email}|#{exp}") }
  end

  # Per-platform connection status for one agent (bridge GET /connect/status); raises on failure.
  def status(user)
    response = HTTParty.get("#{internal_url}/connect/status", query: { a: user.id, e: user.email.downcase },
                                                              headers: { 'X-Kita-Bridge-Secret' => secret }, timeout: STATUS_TIMEOUT)
    raise "bridge status #{response.code}" unless response.success?

    response.parsed_response
  end

  # Bridge-supplied message metadata: the platform it came through, the desk message it replies to
  # (thread root, rendered with Chatwoot's native reply UI) and the platform thread it belongs to.
  def message_attributes(raw)
    return {} unless raw.respond_to?(:permit)

    attrs = raw.permit(:external_source, :in_reply_to, external_thread: [:root]).to_h
    attrs.delete(:external_source) unless EXTERNAL_SOURCES.include?(attrs[:external_source])
    attrs[:in_reply_to] = attrs[:in_reply_to].to_i if attrs[:in_reply_to].present?
    attrs.compact_blank
  end

  def valid_secret?(given)
    given.present? && ActiveSupport::SecurityUtils.secure_compare(given, secret)
  end
end
