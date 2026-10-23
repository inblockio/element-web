/*
Copyright 2026 inblock.io

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

// Rocket.Chat's own logo assets, for brand.spec.ts (REQ-0008 V2): file name and sha256 of every file in
// apps/meteor/public/images/logo of the pinned Rocket.Chat tree, and the first 40 characters of every SVG path
// data string in them (an inline copy of the logo has no file to hash). Regenerate on a Rocket.Chat bump: hash each
// file of that directory and take the first 40 characters of every ` d="..."` attribute of its .svg files.

export const RC_LOGO_SHA256: Record<string, string> = {
    "1024x1024.png": "2f22aa749e738d26b58d06013bbe0f2272da7d6bb5c580d02d2bee16ffd95a07",
    "android-chrome-192x192.png": "f1036e2d30a9fb45fc026f6bbc16937dddf1e0ed41e797027db9dceee18e19ed",
    "android-chrome-512x512.png": "1400e2a26ab7460b883818d34f6f4ca647881c045fbe49f5bac10e9d4fe09936",
    "apple-touch-icon-precomposed.png": "cea63ad72b9363110a7f15ab7d2c2283a88dd8a91bb9c4aa7f2b80ad00eca02f",
    "apple-touch-icon.png": "1a0db31b5ca6fed900fd1f52b96aebacd3ae9a722ee0a7849332ce6b2dc316e4",
    "favicon-16x16.png": "301e8117fb80e77181e42d1042a7a6ad06c9701a80cf34ff2db665ec9dcff6c7",
    "favicon-32x32.png": "a58876dfcabbe9eb7109f637258474617f68951e04b69f84c130e4952401fd2a",
    "icon.svg": "189d1b2ef423265d7762f57af5886771cb5670ca2cad5f1aa22e02720e23e236",
    "logo.png": "5a19578d855252a329859a9c9d1ee5a32680aaf3b76f34a4df105e2fedbe8cde",
    "logo.svg": "69667b337f5ffed0170509cb79f50ca48c0dc26626ca08d5f7ae0f73efaa551e",
    "logo_dark.png": "5a19578d855252a329859a9c9d1ee5a32680aaf3b76f34a4df105e2fedbe8cde",
    "logo_dark.svg": "69667b337f5ffed0170509cb79f50ca48c0dc26626ca08d5f7ae0f73efaa551e",
    "mstile-144x144.png": "ab1704e12757028d57b7984598b35c0ef3ed625cc98af9b7b4ade7d13eb2fde6",
    "mstile-150x150.png": "45c68116d8c9de32521de98eefb54802fb80b959a6d2f42cc850226f6e3c3c63",
    "mstile-310x150.png": "77d63f582d616bd240daf5e20e30ce7aaf81b2f55f260749ed8e0a946f7ef74d",
    "mstile-310x310.png": "c0bd34249626e54e773560c3b26887f18de25a77967f71acba024e21269c8f3c",
    "mstile-70x70.png": "f3d572b6fa7702e9f051d22c6f9d8c1c2e1b3d32b4226dfeaacc25ff02735ab9",
    "safari-pinned-tab.svg": "2f63582c3ea2048b8d7a90cc9f882b29382c3367b02f1b41c1c5575cb2a1ece6",
};

export const RC_LOGO_PATH_PREFIXES: string[] = [
    "M150.479 73.2679C147.083 67.994 142.323 ",
    "M68.5569 85.3376C64.4134 85.3376 61.0547",
    "M92.7034 85.3376C88.5599 85.3376 85.2012",
    "M116.854 85.3376C112.71 85.3376 109.352 ",
    "M687.178 68.3765H699.452V85.2808H710.808",
    "M663.995 92.7303V85.2809H676.268V136.708",
    "M209.724 136.708V85.2808H221.896V92.9317",
    "M243.992 110.995C243.992 103.339 246.755",
    "M351.3 88.852V101.095C346.903 96.9104 34",
    "M360.407 136.708V68.3765H372.58V107.217L",
    "M405.824 110.994C405.824 102.931 408.28 ",
    "M466.944 68.3765H479.218V85.2808H490.573",
    "M502.713 123.215C498.642 123.215 495.342",
    "M558.22 88.852V101.095C553.823 96.9104 5",
    "M567.326 136.708V68.3765H579.499V92.4234",
    "M174.643 91.8055C171.307 86.6179 166.629",
    "M94.1449 103.678C90.0736 103.678 86.7734",
    "M117.875 103.678C113.804 103.678 110.504",
    "M141.605 103.678C137.534 103.678 134.233",
    "M422.968 205.942C413.422 191.118 400.042",
    "M192.7 239.868C181.053 239.868 171.612 2",
    "M260.571 239.868C248.925 239.868 239.484",
    "M328.455 239.868C316.808 239.868 307.367",
];
