/**
 * Every external input that OpenRCA scoring depends on, pinned to one version.
 *
 * The inputs are the dataset archives on Google Drive, the size and SHA-256 of
 * each file this package reads from them, and the OpenRCA commit whose
 * evaluator scores predictions. A change to any of them can change every score,
 * so change them only together with the expected results in the README.
 *
 * @module
 */
import telemetry from "./pinned-telemetry.json" with { type: "json" };
import type { OpenRcaSystem, ScenarioFile } from "./scenarios.js";

/** OpenRCA's git repository. */
export const openRcaRepository = "https://github.com/microsoft/OpenRCA.git";

/**
 * The OpenRCA commit whose `main/evaluate.py` scores predictions and whose
 * `rca/archive/` holds the archived RCA-Agent predictions.
 */
export const openRcaCommit = "2a481ae63cb045c3eadbeca9eddaa10ec1151979";

/** A zip archive that a server offers for HTTP Range requests. `bytes` is its size. */
export type Archive = {
  readonly url: string;
  readonly bytes: number;
};

// `confirm=t` skips the page where Drive warns that it cannot scan a large file for viruses.
function onDrive(driveId: string, bytes: number) {
  return {
    driveId,
    bytes,
    url: `https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`,
  };
}

/** The published dataset archives on Google Drive, by name. */
export const driveArchives = {
  Bank: onDrive("1enBrdPT3wLG94ITGbSOwUFg9fkLR-16R", 2829139841),
  Telecom: onDrive("1cyOKpqyAP4fy-QiJ6a_cKuwR7D46zyVe", 3071992930),
  Market: onDrive("1aDbqFHhYGgywLDfq54O7Ln8wgiv-BqGJ", 2865427796),
} satisfies Record<string, Archive>;

/** The name of the archive that holds each system's files. */
export const archiveOf: Record<OpenRcaSystem, keyof typeof driveArchives> = {
  Bank: "Bank",
  Telecom: "Telecom",
  "Market/cloudbed-1": "Market",
  "Market/cloudbed-2": "Market",
};

/** The size of a file's contents and their SHA-256 in lowercase hex. */
export type FileDigest = {
  readonly bytes: number;
  readonly sha256: string;
};

/** The path of an answer key inside its published archive, such as `Telecom/query.csv`. */
export type AnswerKeyFile = `${OpenRcaSystem}/${ScenarioFile}`;

/** The digest of each published answer key. */
export const answerKeyFiles: Record<AnswerKeyFile, FileDigest> = {
  "Bank/query.csv": {
    bytes: 56803,
    sha256: "605d3b5c863928caf1611d97858379765858595e150efad2f77d2f733774f588",
  },
  "Bank/record.csv": {
    bytes: 8668,
    sha256: "eea788a8c6d07d5d9567067d1e740fe71f3221d8357f0e12e1c643c42cbd15f7",
  },
  "Telecom/query.csv": {
    bytes: 20356,
    sha256: "c2726ea18183a05c83dfb22796d20cb7a371ce4db51ce3da3fda3f6e793735b5",
  },
  "Telecom/record.csv": {
    bytes: 3030,
    sha256: "a98aa504db6604d6008dc815d3a30babb96caedc199bffcaf70b6677da2f65e2",
  },
  "Market/cloudbed-1/query.csv": {
    bytes: 33649,
    sha256: "3512ba2d72648f251e7e01733f079c492a4ff573de557a0223ea538bd9c06742",
  },
  "Market/cloudbed-1/record.csv": {
    bytes: 5356,
    sha256: "6246b65915ecaa948037875a149a3d50afdc730371c8b4e3785799995d589324",
  },
  "Market/cloudbed-2/query.csv": {
    bytes: 36012,
    sha256: "140300e5edfe287a60944dedeaed08291c298bcc672a070a0630b2835f5a5aee",
  },
  "Market/cloudbed-2/record.csv": {
    bytes: 6027,
    sha256: "b12d8c91518cf31e10fdce3ce2e6d38fe259013b73ed9460635022afc12f6162",
  },
};

/**
 * The path of a telemetry file inside its published archive, such as
 * `Telecom/telemetry/2020_04_11/trace/trace_span.csv`.
 */
export type TelemetryFile = `${OpenRcaSystem}/telemetry/${string}`;

/**
 * The digest of each published telemetry file, which
 * `pnpm --filter @evorca/openrca pin-telemetry` writes to `pinned-telemetry.json`.
 */
export const telemetryFiles: Readonly<Record<TelemetryFile, FileDigest>> = telemetry;

/**
 * The pins that scoring depends on as one record, for a report that names what
 * produced its scores. It leaves out the telemetry, which scoring never reads.
 */
export const pinnedInputs = {
  repository: openRcaRepository,
  commit: openRcaCommit,
  driveArchives,
  answerKeySha256: Object.fromEntries(
    Object.entries(answerKeyFiles).map(([file, { sha256 }]) => [file, sha256]),
  ),
};
