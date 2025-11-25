export type MerkleNodeType = "file" | "directory";

export interface MerkleNode {
     path: string;
     hash: string;
     type: MerkleNodeType;
     size?: number;
     children: MerkleNode[];
}

export interface MerkleBuildResult {
     root: MerkleNode;
     nodes: Map<string, MerkleNode>;
}

export interface MerkleDiff {
     changedFiles: string[];
     deletedFiles: string[];
     addedFiles: string[];
     hasChanges: boolean;
}
