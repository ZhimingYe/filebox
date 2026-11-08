use thiserror::Error;

pub const MAX_DATA_CHUNK: usize = 32 * 1024;
pub const MAX_WS_MESSAGE: usize = 64 * 1024;
const FRAME_HEADER: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frame {
    Data,
    Eof,
    Ready,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("truncated or invalid frame header")]
    Header,
    #[error("invalid frame type or flags")]
    Type,
    #[error("frame exceeds the configured size limit")]
    TooLarge,
    #[error("compression was not negotiated")]
    CompressionNotNegotiated,
    #[error("invalid compressed frame")]
    Compression,
}

pub fn encode_data(data: &[u8], compression: bool) -> Result<Vec<u8>, FrameError> {
    if data.len() > MAX_DATA_CHUNK {
        return Err(FrameError::TooLarge);
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER + data.len());
    frame.extend_from_slice(&[1, 0, 0]);
    if compression && data.len() >= 1024 {
        let compressed = zstd::bulk::compress(data, 1).map_err(|_| FrameError::Compression)?;
        if compressed.len() * 10 <= data.len() * 9 {
            frame[2] = 1;
            frame.extend_from_slice(&compressed);
            if frame.len() <= MAX_WS_MESSAGE {
                return Ok(frame);
            }
            frame.truncate(FRAME_HEADER);
            frame[2] = 0;
        }
    }
    frame.extend_from_slice(data);
    if frame.len() > MAX_WS_MESSAGE {
        return Err(FrameError::TooLarge);
    }
    Ok(frame)
}

pub fn encode_eof() -> Vec<u8> {
    vec![1, 1, 0]
}

pub fn encode_ready() -> Vec<u8> {
    vec![1, 2, 0]
}

pub fn decode_frame(frame: &[u8], compression: bool) -> Result<(Frame, Vec<u8>), FrameError> {
    if frame.len() < FRAME_HEADER || frame[0] != 1 {
        return Err(FrameError::Header);
    }
    if frame.len() > MAX_WS_MESSAGE {
        return Err(FrameError::TooLarge);
    }
    let kind = frame[1];
    let compressed = frame[2];
    if compressed > 1 {
        return Err(FrameError::Type);
    }
    let payload = &frame[FRAME_HEADER..];
    match kind {
        0 => {
            if compressed == 1 {
                if !compression {
                    return Err(FrameError::CompressionNotNegotiated);
                }
                let size = zstd::zstd_safe::find_frame_compressed_size(payload)
                    .map_err(|_| FrameError::Compression)?;
                if size != payload.len() {
                    return Err(FrameError::Compression);
                }
                let decoded = zstd::bulk::decompress(payload, MAX_DATA_CHUNK + 1)
                    .map_err(|_| FrameError::Compression)?;
                if decoded.len() > MAX_DATA_CHUNK {
                    return Err(FrameError::TooLarge);
                }
                Ok((Frame::Data, decoded))
            } else {
                if payload.len() > MAX_DATA_CHUNK {
                    return Err(FrameError::TooLarge);
                }
                Ok((Frame::Data, payload.to_vec()))
            }
        }
        1 if compressed == 0 && payload.is_empty() => Ok((Frame::Eof, Vec::new())),
        2 if compressed == 0 && payload.is_empty() => Ok((Frame::Ready, Vec::new())),
        _ => Err(FrameError::Type),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codec_roundtrips_raw_compressed_and_empty_payloads() {
        for payload in [vec![], b"hello".to_vec(), vec![b'x'; MAX_DATA_CHUNK]] {
            for compression in [true, false] {
                assert_eq!(decode_frame(&encode_data(&payload, compression).unwrap(), compression).unwrap(), (Frame::Data, payload.clone()));
            }
        }
        assert_eq!(decode_frame(&encode_ready(), false).unwrap().0, Frame::Ready);
        assert_eq!(decode_frame(&encode_eof(), false).unwrap().0, Frame::Eof);
    }
    #[test]
    fn codec_rejects_unnegotiated_compression_bombs_and_invalid_frames() {
        let compressed = encode_data(&vec![b'x'; MAX_DATA_CHUNK], true).unwrap();
        assert_eq!(decode_frame(&compressed, false), Err(FrameError::CompressionNotNegotiated));
        let mut bomb = vec![1, 0, 1];
        bomb.extend(zstd::bulk::compress(&vec![b'x'; MAX_DATA_CHUNK + 1], 1).unwrap());
        assert!(decode_frame(&bomb, true).is_err());
        for frame in [vec![], vec![2, 0, 0], vec![1, 3, 0], vec![1, 1, 1], vec![1, 0, 2]] { assert!(decode_frame(&frame, true).is_err()); }
        assert!(encode_data(&vec![0; MAX_DATA_CHUNK + 1], true).is_err());
    }
}
