interface DoctorCheckJson {
  readonly name: string
  readonly status: string
  readonly fix?: string
}

interface DoctorRepoJson {
  readonly repo: string
  readonly currentEmail: string
  readonly expectedEmail: string
  readonly status: string
  readonly checks: ReadonlyArray<DoctorCheckJson>
}

const isDoctorCheck = (value: unknown): value is DoctorCheckJson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return false}
  if (!("name" in value) || typeof value.name !== "string") {return false}
  if (!("status" in value) || typeof value.status !== "string") {return false}
  if ("fix" in value && value.fix !== undefined && typeof value.fix !== "string") {return false}
  return true
}

const isDoctorRepo = (value: unknown): value is DoctorRepoJson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return false}
  if (!("repo" in value) || typeof value.repo !== "string") {return false}
  if (!("currentEmail" in value) || typeof value.currentEmail !== "string") {return false}
  if (!("expectedEmail" in value) || typeof value.expectedEmail !== "string") {return false}
  if (!("status" in value) || typeof value.status !== "string") {return false}
  if (!("checks" in value) || !Array.isArray(value.checks) || !value.checks.every(isDoctorCheck)) {return false}
  return true
}

export const doctorRepo = (text: string): DoctorRepoJson => {
  const value: unknown = JSON.parse(text)
  if (!isDoctorRepo(value)) {throw new Error("doctor json was not a repo report")}
  return value
}

export const doctorRepos = (text: string): ReadonlyArray<DoctorRepoJson> => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || !("repos" in value) || !Array.isArray(value.repos) || !value.repos.every(isDoctorRepo)) {
    throw new Error("doctor json was not a repo list")
  }
  return value.repos
}
