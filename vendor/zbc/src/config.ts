interface ZbcConfig {
  project: string
  environments: string[]
}

export function defineConfig(config: ZbcConfig): ZbcConfig {
  return config
}
