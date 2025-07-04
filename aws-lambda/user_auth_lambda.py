import json
import boto3
import hashlib
import uuid
import time
import os
import re
from typing import Dict, Any
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import logging
import jwt
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

class UserAuthService:
    def __init__(self):
        self.dynamodb = boto3.resource('dynamodb')
        self.users_table_name = os.environ.get('USERS_TABLE_NAME', 'word-munch-users')
        self.users_table = self.dynamodb.Table(self.users_table_name)
        
        # JWT settings
        self.jwt_secret = os.environ.get('JWT_SECRET', 'word-munch-secret-key-change-in-production')
        self.jwt_expiry = int(os.environ.get('JWT_EXPIRY_DAYS', '30')) * 24 * 60 * 60  # 30 days
        
        # Security settings
        self.min_password_length = 8
        self.max_login_attempts = 5
        self.lockout_duration = 15 * 60  # 15 minutes
        
    def register_user(self, name: str, email: str, password: str) -> Dict[str, Any]:
        """Register a new user"""
        try:
            # Validate input
            validation_error = self.validate_registration_input(name, email, password)
            if validation_error:
                return {
                    'success': False,
                    'error': validation_error
                }
            
            # Normalize email
            email = email.lower().strip()
            
            # Check if user already exists
            if self.user_exists(email):
                return {
                    'success': False,
                    'error': 'An account with this email already exists'
                }
            
            # Generate user ID and hash password
            user_id = str(uuid.uuid4())
            password_hash = self.hash_password(password)
            
            # Create user record
            user_data = {
                'userId': user_id,
                'email': email,
                'name': name.strip(),
                'passwordHash': password_hash,
                'createdAt': datetime.now(timezone.utc).isoformat(),
                'lastLoginAt': None,
                'loginAttempts': 0,
                'lockedUntil': None,
                'isActive': True,
                'emailVerified': False,  # Future feature
                'cognitiveProfileCount': 0,
                'lastActivityAt': datetime.now(timezone.utc).isoformat()
            }
            
            # Save to DynamoDB
            self.users_table.put_item(
                Item=user_data,
                ConditionExpression='attribute_not_exists(email)'
            )
            
            # Generate JWT token
            token = self.generate_jwt_token(user_id, email)
            
            # Update last login
            self.update_last_login(email)
            
            logger.info(f"User registered successfully: {email}")
            
            return {
                'success': True,
                'user': {
                    'id': user_id,
                    'email': email,
                    'name': name.strip()
                },
                'token': token,
                'message': 'Account created successfully'
            }
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return {
                    'success': False,
                    'error': 'An account with this email already exists'
                }
            else:
                logger.error(f"DynamoDB error during registration: {e}")
                return {
                    'success': False,
                    'error': 'Registration failed due to server error'
                }
        except Exception as e:
            logger.error(f"Registration error: {e}")
            return {
                'success': False,
                'error': 'Registration failed. Please try again.'
            }
    
    def login_user(self, email: str, password: str) -> Dict[str, Any]:
        """Authenticate user login"""
        try:
            # Validate input
            if not email or not password:
                return {
                    'success': False,
                    'error': 'Email and password are required'
                }
            
            # Normalize email
            email = email.lower().strip()
            
            # Get user record
            user = self.get_user_by_email(email)
            if not user:
                return {
                    'success': False,
                    'error': 'Invalid email or password'
                }
            
            # Check if account is locked
            if self.is_account_locked(user):
                return {
                    'success': False,
                    'error': 'Account temporarily locked due to too many failed attempts. Please try again later.'
                }
            
            # Check if account is active
            if not user.get('isActive', True):
                return {
                    'success': False,
                    'error': 'Account is deactivated. Please contact support.'
                }
            
            # Verify password
            if not self.verify_password(password, user['passwordHash']):
                # Increment login attempts
                self.increment_login_attempts(email)
                return {
                    'success': False,
                    'error': 'Invalid email or password'
                }
            
            # Reset login attempts on successful login
            self.reset_login_attempts(email)
            
            # Update last login
            self.update_last_login(email)
            
            # Generate JWT token
            token = self.generate_jwt_token(user['userId'], email)
            
            logger.info(f"User logged in successfully: {email}")
            
            return {
                'success': True,
                'user': {
                    'id': user['userId'],
                    'email': user['email'],
                    'name': user['name']
                },
                'token': token,
                'message': 'Login successful'
            }
            
        except Exception as e:
            logger.error(f"Login error: {e}")
            return {
                'success': False,
                'error': 'Login failed. Please try again.'
            }
    
    def validate_token(self, token: str) -> Dict[str, Any]:
        """Validate JWT token"""
        try:
            payload = jwt.decode(token, self.jwt_secret, algorithms=['HS256'])
            
            # Check if user still exists and is active
            user = self.get_user_by_email(payload['email'])
            if not user or not user.get('isActive', True):
                return {
                    'success': False,
                    'error': 'Invalid token'
                }
            
            return {
                'success': True,
                'user': {
                    'id': user['userId'],
                    'email': user['email'],
                    'name': user['name']
                }
            }
            
        except jwt.ExpiredSignatureError:
            return {
                'success': False,
                'error': 'Token has expired'
            }
        except jwt.InvalidTokenError:
            return {
                'success': False,
                'error': 'Invalid token'
            }
        except Exception as e:
            logger.error(f"Token validation error: {e}")
            return {
                'success': False,
                'error': 'Token validation failed'
            }
    
    def validate_registration_input(self, name: str, email: str, password: str) -> str:
        """Validate registration input data"""
        if not name or not name.strip():
            return 'Name is required'
        
        if len(name.strip()) > 100:
            return 'Name is too long'
        
        if not email or not email.strip():
            return 'Email is required'
        
        if not self.is_valid_email(email.strip()):
            return 'Please enter a valid email address'
        
        if not password:
            return 'Password is required'
        
        if len(password) < self.min_password_length:
            return f'Password must be at least {self.min_password_length} characters long'
        
        if len(password) > 100:
            return 'Password is too long'
        
        # Check password strength
        if not self.is_strong_password(password):
            return 'Password must contain at least one letter and one number'
        
        return None
    
    def is_valid_email(self, email: str) -> bool:
        """Check if email format is valid and domain is valid"""
        email_pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        if not re.match(email_pattern, email):
            return False
        
        # Additional check for valid domain
        domain = email.split('@')[-1]
        valid_domains = ['com', 'org', 'net', 'edu', 'gov', 'mil', 'int']  # Add more as needed
        domain_parts = domain.split('.')
        if len(domain_parts) < 2:
            return False
        
        # Check if the top-level domain is in the list of valid domains
        if domain_parts[-1] not in valid_domains:
            return False
        
        return True
    
    def is_strong_password(self, password: str) -> bool:
        """Check if password meets strength requirements"""
        has_letter = re.search(r'[a-zA-Z]', password)
        has_number = re.search(r'\d', password)
        return has_letter and has_number
    
    def hash_password(self, password: str) -> str:
        """Hash password using SHA-256 with salt"""
        salt = os.urandom(32)
        pwdhash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
        return salt.hex() + pwdhash.hex()
    
    def verify_password(self, password: str, stored_hash: str) -> bool:
        """Verify password against stored hash"""
        try:
            salt = bytes.fromhex(stored_hash[:64])
            stored_pwdhash = stored_hash[64:]
            pwdhash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
            return pwdhash.hex() == stored_pwdhash
        except Exception as e:
            logger.error(f"Password verification error: {e}")
            return False
    
    def generate_jwt_token(self, user_id: str, email: str) -> str:
        """Generate JWT token for user"""
        payload = {
            'user_id': user_id,
            'email': email,
            'iat': int(time.time()),
            'exp': int(time.time()) + self.jwt_expiry
        }
        return jwt.encode(payload, self.jwt_secret, algorithm='HS256')
    
    def user_exists(self, email: str) -> bool:
        """Check if user with email exists"""
        try:
            response = self.users_table.get_item(Key={'email': email})
            return 'Item' in response
        except Exception:
            return False
    
    def get_user_by_email(self, email: str) -> Dict:
        """Get user record by email"""
        try:
            response = self.users_table.get_item(Key={'email': email})
            return response.get('Item')
        except Exception:
            return None
    
    def is_account_locked(self, user: Dict) -> bool:
        """Check if account is locked due to failed login attempts"""
        locked_until = user.get('lockedUntil')
        if not locked_until:
            return False
        
        locked_until_time = datetime.fromisoformat(locked_until.replace('Z', '+00:00'))
        return datetime.now(timezone.utc) < locked_until_time
    
    def increment_login_attempts(self, email: str):
        """Increment failed login attempts"""
        try:
            current_time = datetime.now(timezone.utc).isoformat()
            
            response = self.users_table.update_item(
                Key={'email': email},
                UpdateExpression='ADD loginAttempts :inc SET lastActivityAt = :time',
                ExpressionAttributeValues={
                    ':inc': 1,
                    ':time': current_time
                },
                ReturnValues='UPDATED_NEW'
            )
            
            # Lock account if too many attempts
            new_attempts = response['Attributes']['loginAttempts']
            if new_attempts >= self.max_login_attempts:
                locked_until = datetime.now(timezone.utc) + timedelta(seconds=self.lockout_duration)
                self.users_table.update_item(
                    Key={'email': email},
                    UpdateExpression='SET lockedUntil = :locked',
                    ExpressionAttributeValues={
                        ':locked': locked_until.isoformat()
                    }
                )
                
        except Exception as e:
            logger.error(f"Failed to increment login attempts: {e}")
    
    def reset_login_attempts(self, email: str):
        """Reset failed login attempts"""
        try:
            self.users_table.update_item(
                Key={'email': email},
                UpdateExpression='SET loginAttempts = :zero REMOVE lockedUntil',
                ExpressionAttributeValues={
                    ':zero': 0
                }
            )
        except Exception as e:
            logger.error(f"Failed to reset login attempts: {e}")
    
    def update_last_login(self, email: str):
        """Update user's last login time"""
        try:
            current_time = datetime.now(timezone.utc).isoformat()
            self.users_table.update_item(
                Key={'email': email},
                UpdateExpression='SET lastLoginAt = :time, lastActivityAt = :time',
                ExpressionAttributeValues={
                    ':time': current_time
                }
            )
        except Exception as e:
            logger.error(f"Failed to update last login: {e}")


def lambda_handler(event, context):
    """
    User Authentication Lambda Handler
    Handles user registration, login, and token validation
    """
    try:
        # Parse request
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body', {})
        
        action = body.get('action')
        
        if not action:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
                },
                'body': json.dumps({
                    'success': False,
                    'error': 'Missing required field: action'
                })
            }
        
        # Initialize auth service
        auth_service = UserAuthService()
        
        if action == 'register':
            return handle_register(auth_service, body)
        
        elif action == 'login':
            return handle_login(auth_service, body)
        
        elif action == 'validate_token':
            return handle_validate_token(auth_service, body)
        
        else:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'success': False,
                    'error': f'Unknown action: {action}'
                })
            }
        
    except Exception as e:
        logger.error(f"User auth lambda handler error: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'success': False,
                'error': 'Internal server error'
            })
        }


def handle_register(auth_service, body):
    """Handle user registration"""
    name = body.get('name')
    email = body.get('email')
    password = body.get('password')
    
    if not all([name, email, password]):
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'success': False,
                'error': 'Name, email, and password are required'
            })
        }
    
    result = auth_service.register_user(name, email, password)
    
    return {
        'statusCode': 200 if result['success'] else 400,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(result)
    }


def handle_login(auth_service, body):
    """Handle user login"""
    email = body.get('email')
    password = body.get('password')
    
    if not all([email, password]):
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'success': False,
                'error': 'Email and password are required'
            })
        }
    
    result = auth_service.login_user(email, password)
    
    return {
        'statusCode': 200 if result['success'] else 400,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(result)
    }


def handle_validate_token(auth_service, body):
    """Handle token validation"""
    token = body.get('token')
    
    if not token:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'success': False,
                'error': 'Token is required'
            })
        }
    
    result = auth_service.validate_token(token)
    
    return {
        'statusCode': 200 if result['success'] else 400,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(result)
    } 