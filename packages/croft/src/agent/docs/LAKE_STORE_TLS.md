# LAKE_STORE_TLS: croft cannot check the certificate of the lake's bucket, so it cannot read or write it

In lake mode the Parquet files of the warehouse are in a bucket folder of an S3-compatible store (R2, S3, MinIO),
reached over HTTPS. DuckDB checks the store's certificate against a file of certificate authorities (a CA bundle),
and croft lets it read exactly one file for that: the one `lake.bucket.sslRootCert` names. This code means that check
could not be made or did not pass. Every command that meets it reports this code, whatever it was doing: `croft run`,
`query`, `status`, `doctor`, `backup`, `maintain`, `serve`. details.kind says which:

- `no-ca-file`: croft had no CA file to give DuckDB (DuckDB's words: "Cannot read a CA certificate bundle"). Nothing
  was read from or written to the bucket.
- `untrusted`: the store answered, and its certificate is not signed by an authority in the file, or is issued for
  another name than `lake.bucket.endpoint` (DuckDB's words: "SSL peer certificate ... was not OK"). A store with a
  certificate of a private authority, or a proxy that re-signs traffic, looks like this.

Nothing was written, and trying again will not change the answer.

What to do (the settings are the user's; ask them):
- Set `"lake.bucket.sslRootCert"` in croft.json to the PEM file of the authorities the store's certificate is signed
  by (relative to the project folder; `~/` for the home folder): the file the store's provider publishes, or the
  private authority's. A machine's own bundle (macOS: /etc/ssl/cert.pem; Debian: /etc/ssl/certs/ca-certificates.crt)
  is a file that works too, for a store with a public certificate.
- `croft doctor` shows which file croft uses and whether the bucket answers with it.
- Never turn `"lake.bucket.useSsl"` off for a store on a network, and never ask croft to skip the check: that is the
  user's decision, and croft has no setting for it. The catalog's connection is a different matter
  (LAKE_ATTACH_FAILED).
