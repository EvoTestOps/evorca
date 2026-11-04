/**
 * Every external input that OpenRCA scoring depends on, pinned to one version.
 *
 * The inputs are the dataset archives on Google Drive, the SHA-256 of each file
 * this package reads from them, and the OpenRCA commit whose evaluator scores
 * predictions. A change to any of them can change every score, so change them
 * only together with the expected results in the README.
 *
 * @module
 */
import type { OpenRcaSystem } from "./tasks.js";

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

/** The path of a file this package reads, relative to the dataset directory and inside its archive. */
export type DataFile = `${OpenRcaSystem}/${"query" | "record"}.csv`;

/** The SHA-256 of each published file, in lowercase hex. */
export const dataFileSha256: Record<DataFile, string> = {
  "Bank/query.csv": "605d3b5c863928caf1611d97858379765858595e150efad2f77d2f733774f588",
  "Bank/record.csv": "eea788a8c6d07d5d9567067d1e740fe71f3221d8357f0e12e1c643c42cbd15f7",
  "Telecom/query.csv": "c2726ea18183a05c83dfb22796d20cb7a371ce4db51ce3da3fda3f6e793735b5",
  "Telecom/record.csv": "a98aa504db6604d6008dc815d3a30babb96caedc199bffcaf70b6677da2f65e2",
  "Market/cloudbed-1/query.csv": "3512ba2d72648f251e7e01733f079c492a4ff573de557a0223ea538bd9c06742",
  "Market/cloudbed-1/record.csv":
    "6246b65915ecaa948037875a149a3d50afdc730371c8b4e3785799995d589324",
  "Market/cloudbed-2/query.csv": "140300e5edfe287a60944dedeaed08291c298bcc672a070a0630b2835f5a5aee",
  "Market/cloudbed-2/record.csv":
    "b12d8c91518cf31e10fdce3ce2e6d38fe259013b73ed9460635022afc12f6162",
};
