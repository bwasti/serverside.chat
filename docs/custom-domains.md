# Custom domains

Room owners and site admins may attach up to five custom hostnames to a non-system room. In the room chat, run:

```text
/domain add example.com
```

The domain screen supplies two DNS records. First add the unique TXT ownership challenge exactly as shown. Then point the hostname at the room's native `*.serverside.chat` site with a CNAME. For a zone apex, use the registrar's ALIAS, ANAME, or CNAME-flattening feature. Run `/domain verify example.com` after DNS propagates. `/domain` lists bindings and `/domain remove example.com` disables routing and future certificate issuance.

The host stores pending and active bindings in the account database. A binding is globally unique, follows a room rename, and is deleted when the room is archived or deleted. Pending domains never route and cannot authorize Caddy certificate issuance. Verification performs a bounded DNS lookup only when an authorized owner asks for it; Caddy's on-demand TLS authorization path is a constant-time indexed database lookup.

Custom domains are guest service origins. They do not receive control-plane cookies or expose the development chat. Room code owns every path and query parameter except the host-reserved `__ref` deployment selector, just as it does on the native room hostname.
